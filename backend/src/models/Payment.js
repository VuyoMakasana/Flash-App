const BaseModel = require("./BaseModel");
const crypto = require("crypto");
const { encrypt, decrypt } = require("../utils/paymentCrypto");

class Payment extends BaseModel {
  static tableName = "payments";

  static async createPayment(
    orderId,
    userId,
    amount,
    method,
    provider,
    transactionId,
    type = "store",
  ) {
    return await super.create(this.tableName, {
      order_id: orderId,
      user_id: userId,
      amount,
      method,
      provider,
      provider_transaction_id: transactionId,
      status: "paid",
      type,
    });
  }

  static async getSavedCards(userId) {
    const result = await this.query(
      `SELECT id, provider, last4, brand,
              exp_month, exp_year, is_default
       FROM payment_methods WHERE user_id=$1`,
      [userId],
    );
    const cards = result.rows;
    cards.sort((a, b) => (a.is_default === b.is_default ? 0 : a.is_default ? -1 : 1));
    return cards;
  }

  static async getSavedCardById(cardId, userId) {
    const result = await this.query(
      `SELECT id, provider, authorization_code, last4, brand,
              exp_month, exp_year, is_default
       FROM payment_methods WHERE id=$1 AND user_id=$2`,
      [cardId, userId],
    );
    if (!result.rows[0]) return null;
    let authorizationCode = null;
    try {
      authorizationCode = decrypt(result.rows[0].authorization_code);
    } catch (_) {
      authorizationCode = result.rows[0].authorization_code;
    }
    return {
      ...result.rows[0],
      authorization_code: authorizationCode,
    };
  }

  static async markOrderPaidByCard(orderId, userId, amount, transactionId) {
    return await this.transaction(async (client) => {
      // Lock the order row first. If two saved-card charge requests arrive
      // simultaneously, the second waits here until the first commits.
      // After the first commits, the second sees payment_status = 'paid'
      // and throws safely — preventing a double charge.
      const orderCheck = await client.query(
        `SELECT id, payment_status FROM orders WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [orderId, userId],
      );

      if (!orderCheck.rows.length) {
        throw new Error("Order not found");
      }

      if (orderCheck.rows[0].payment_status === "paid") {
        throw new Error("Order already paid");
      }

      await client.query(
        `UPDATE orders
         SET payment_status = 'paid', payment_method = 'card',
             delivery_payment_status = 'pending_driver', store_paid = true, updated_at = NOW()
         WHERE id = $1 AND user_id = $2`,
        [orderId, userId],
      );

      // ON CONFLICT DO NOTHING: if the webhook already inserted a record for
      // this transaction, skip the duplicate safely.
      await client.query(
        `INSERT INTO payments
           (order_id, user_id, amount, method, provider, provider_transaction_id, status, type)
         VALUES ($1, $2, $3, 'card', 'paystack', $4, 'paid', 'store')
         ON CONFLICT (provider_transaction_id) DO NOTHING`,
        [orderId, userId, amount, String(transactionId)],
      );
    });
  }

  static authCodeFingerprint(userId, authorizationCode) {
    const secret = process.env.PAYMENT_METHOD_ENCRYPTION_KEY || process.env.JWT_SECRET || "flash-dev-fallback-key";
    return crypto
      .createHmac("sha256", secret)
      .update(`${userId}:${authorizationCode}`)
      .digest("hex");
  }

  static async saveCard(userId, auth) {
    const encryptedAuthorizationCode = encrypt(auth.authorization_code);
    const fingerprint = this.authCodeFingerprint(userId, auth.authorization_code);
    const result = await this.query(
      `INSERT INTO payment_methods
         (user_id, provider, authorization_code, auth_fingerprint, last4, brand, exp_month, exp_year, is_default)
       VALUES ($1,'paystack',$2,$3,$4,$5,$6,$7,false)
       ON CONFLICT (user_id, provider, auth_fingerprint) DO NOTHING
       RETURNING *`,
      [
        userId,
        encryptedAuthorizationCode,
        fingerprint,
        auth.last4,
        auth.card_type,
        auth.exp_month,
        auth.exp_year,
      ],
    );
    return result.rows[0];
  }

  static async removeCard(cardId, userId) {
    const cardResult = await this.query(
      "SELECT id, is_default FROM payment_methods WHERE id=$1 AND user_id=$2",
      [cardId, userId],
    );

    if (!cardResult.rows.length) {
      throw new Error("Card not found");
    }

    await this.query("DELETE FROM payment_methods WHERE id=$1", [cardId]);

    if (cardResult.rows[0].is_default) {
      await this.query(
        `UPDATE payment_methods SET is_default=true
         WHERE user_id=$1 AND id=(SELECT id FROM payment_methods WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1)`,
        [userId],
      );
    }
  }

  static async setDefaultCard(cardId, userId) {
    return await this.transaction(async (client) => {
      await client.query("UPDATE payment_methods SET is_default=false WHERE user_id=$1", [userId]);

      let result = await client.query(
        "UPDATE payment_methods SET is_default=true WHERE id=$1 AND user_id=$2 RETURNING id",
        [cardId, userId],
      );
      if (!result.rows.length) {
        throw new Error("Card not found");
      }
    });
  }

  static async cashOnDelivery(orderId, userId, io) {
    return await this.transaction(async (client) => {
      const orderResult = await client.query(
        "SELECT id, delivery_fee, driver_payout, total, user_id, status FROM orders WHERE id=$1",
        [orderId],
      );

      if (!orderResult.rows.length) {
        throw new Error("Order not found");
      }

      const order = orderResult.rows[0];
      if (order.user_id !== userId) {
        throw new Error("Not your order");
      }

      await client.query(
        `UPDATE orders SET payment_method='cash', payment_status='pending_cash',
         delivery_payment_method='cash', delivery_payment_status='pending_driver',
         is_cash_delivery=true, cash_to_collect=$2, updated_at=NOW()
         WHERE id=$1`,
        [orderId, order.total],
      );

      await client.query(
        `INSERT INTO payments (order_id, user_id, amount, method, provider, status, type)
         VALUES ($1,$2,$3,'cash','cash_on_delivery','pending_cash','delivery')`,
        [orderId, userId, order.total],
      );

      // FIXED (trusted driver): re-fetch preferred_driver_id /
      // preferred_driver_expires_at so the broadcast can be scoped. If a
      // customer selected a trusted driver and the exclusivity window has
      // not yet expired, only that driver's room is notified. Once the
      // window lapses (or no preferred driver was chosen), behaviour is
      // unchanged — broadcast to the whole driver_pool.
      const prefResult = await client.query(
        `SELECT preferred_driver_id, preferred_driver_expires_at FROM orders WHERE id=$1`,
        [orderId],
      );
      const pref = prefResult.rows[0] || {};
      const hasUnexpiredPreference =
        pref.preferred_driver_id &&
        pref.preferred_driver_expires_at &&
        new Date(pref.preferred_driver_expires_at).getTime() > Date.now();

      if (io) {
        const payload = {
          orderId,
          isCashDelivery: true,
          deliveryFee: order.delivery_fee,
          cashNote: `Cash delivery — collect R${parseFloat(order.total || 0).toFixed(2)} on arrival`,
        };

        if (hasUnexpiredPreference) {
          io.to(`driver:${pref.preferred_driver_id}`).emit("new_order_available", {
            ...payload,
            preferredAssignment: true,
          });
        } else {
          io.to("driver_pool").emit("new_order_available", payload);
        }
      }

      return {
        success: true,
        paymentMethod: "cash",
        isCashDelivery: true,
        deliveryFee: order.delivery_fee,
      };
    });
  }

  static async initiatePayflex(orderId, userId) {
    const orderResult = await this.query(
      "SELECT id, subtotal, user_id FROM orders WHERE id=$1",
      [orderId],
    );

    if (!orderResult.rows.length) {
      throw new Error("Order not found");
    }

    const order = orderResult.rows[0];
    if (order.user_id !== userId) {
      throw new Error("Not your order");
    }

    const payflexUrl = `https://checkout.payflex.co.za/?token=${process.env.PAYFLEX_API_KEY}&orderId=${orderId}`;

    await this.query(
      "UPDATE orders SET payflex_order_id=$1, payment_method=$2, updated_at=NOW() WHERE id=$3",
      [orderId, "payflex", orderId],
    );

    return { checkoutUrl: payflexUrl, payflexOrderId: orderId };
  }
}

module.exports = Payment;