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
    const methods = await this.query(
      `SELECT id, provider, last4, brand,
              exp_month, exp_year, is_default
       FROM payment_methods WHERE user_id=$1`,
      [userId],
    );

    const legacy = await this.query(
      `SELECT id, 'paystack'::varchar as provider, last4, card_type as brand,
              exp_month, exp_year, is_default
       FROM saved_cards WHERE user_id=$1`,
      [userId],
    );

    const allCards = [...methods.rows, ...legacy.rows];
    allCards.sort((a, b) => (a.is_default === b.is_default ? 0 : a.is_default ? -1 : 1));
    return allCards;
  }

  static async getSavedCardById(cardId, userId) {
    let result = await this.query(
      `SELECT id, provider, authorization_code, last4, brand,
              exp_month, exp_year, is_default
       FROM payment_methods WHERE id=$1 AND user_id=$2`,
      [cardId, userId],
    );
    if (!result.rows[0]) {
      result = await this.query(
        `SELECT id, 'paystack'::varchar as provider, paystack_authorization_code as authorization_code,
                last4, card_type as brand, exp_month, exp_year, is_default
         FROM saved_cards WHERE id=$1 AND user_id=$2`,
        [cardId, userId],
      );
      if (!result.rows[0]) return null;
      return result.rows[0];
    }
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
         SET status = 'waiting_for_driver', payment_status = 'paid', payment_method = 'card',
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
    let cardResult = await this.query(
      "SELECT id, is_default FROM payment_methods WHERE id=$1 AND user_id=$2",
      [cardId, userId],
    );

    let sourceTable = "payment_methods";
    if (!cardResult.rows.length) {
      cardResult = await this.query(
        "SELECT id, is_default FROM saved_cards WHERE id=$1 AND user_id=$2",
        [cardId, userId],
      );
      sourceTable = "saved_cards";
    }

    if (!cardResult.rows.length) {
      throw new Error("Card not found");
    }

    await this.query(`DELETE FROM ${sourceTable} WHERE id=$1`, [cardId]);

    if (cardResult.rows[0].is_default) {
      // Try to promote a new default in the same source table first, then fall back to the other.
      const promoteSameTable = await this.query(
        `UPDATE ${sourceTable} SET is_default=true
         WHERE user_id=$1 AND id=(SELECT id FROM ${sourceTable} WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1)
         RETURNING id`,
        [userId],
      );
      if (!promoteSameTable.rows.length) {
        const otherTable = sourceTable === "payment_methods" ? "saved_cards" : "payment_methods";
        await this.query(
          `UPDATE ${otherTable} SET is_default=true
           WHERE user_id=$1 AND id=(SELECT id FROM ${otherTable} WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1)`,
          [userId],
        );
      }
    }
  }

  static async setDefaultCard(cardId, userId) {
    return await this.transaction(async (client) => {
      await client.query("UPDATE payment_methods SET is_default=false WHERE user_id=$1", [userId]);
      await client.query("UPDATE saved_cards SET is_default=false WHERE user_id=$1", [userId]);

      let result = await client.query(
        "UPDATE payment_methods SET is_default=true WHERE id=$1 AND user_id=$2 RETURNING id",
        [cardId, userId],
      );
      if (!result.rows.length) {
        result = await client.query(
          "UPDATE saved_cards SET is_default=true WHERE id=$1 AND user_id=$2 RETURNING id",
          [cardId, userId],
        );
      }
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
        `UPDATE orders SET status='waiting_for_driver', payment_method='cash', payment_status='pending_cash',
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

      if (io) {
        io.to("driver_pool").emit("new_order_available", {
          orderId,
          isCashDelivery: true,
          deliveryFee: order.delivery_fee,
          cashNote: `Cash delivery — collect R${parseFloat(order.total || 0).toFixed(2)} on arrival`,
        });
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
