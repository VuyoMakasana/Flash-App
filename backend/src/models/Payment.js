const BaseModel = require("./BaseModel");

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
      `SELECT id, paystack_authorization_code, last4, card_type as brand,
              exp_month, exp_year, bank, nickname, is_default
       FROM saved_cards WHERE user_id=$1 ORDER BY is_default DESC, created_at DESC`,
      [userId],
    );
    return result.rows;
  }

  static async getSavedCardById(cardId, userId) {
    const result = await this.query(
      `SELECT id, paystack_authorization_code, last4, card_type as brand,
              exp_month, exp_year, bank, nickname, is_default
       FROM saved_cards WHERE id=$1 AND user_id=$2`,
      [cardId, userId],
    );
    return result.rows[0] || null;
  }

  static async markOrderPaidByCard(orderId, userId, amount, transactionId) {
    return await this.transaction(async (client) => {
      await client.query(
        `UPDATE orders
         SET status='paid', payment_status='paid', payment_method='card', updated_at=NOW()
         WHERE id=$1 AND user_id=$2`,
        [orderId, userId],
      );

      await client.query(
        `INSERT INTO payments (order_id, user_id, amount, method, provider, provider_transaction_id, status, type)
         VALUES ($1,$2,$3,'card','paystack',$4,'paid','store')`,
        [orderId, userId, amount, transactionId],
      );
    });
  }

  static async saveCard(userId, auth) {
    const result = await this.query(
      `INSERT INTO saved_cards
         (user_id, paystack_authorization_code, last4, card_type, bank, exp_month, exp_year, is_default)
       VALUES ($1,$2,$3,$4,$5,$6,$7,false)
       ON CONFLICT (paystack_authorization_code) DO NOTHING
       RETURNING *`,
      [
        userId,
        auth.authorization_code,
        auth.last4,
        auth.card_type,
        auth.bank,
        auth.exp_month,
        auth.exp_year,
      ],
    );
    return result.rows[0];
  }

  static async removeCard(cardId, userId) {
    const cardResult = await this.query(
      "SELECT id, is_default FROM saved_cards WHERE id=$1 AND user_id=$2",
      [cardId, userId],
    );

    if (!cardResult.rows.length) {
      throw new Error("Card not found");
    }

    await this.query("DELETE FROM saved_cards WHERE id=$1", [cardId]);

    if (cardResult.rows[0].is_default) {
      await this.query(
        `UPDATE saved_cards SET is_default=true
         WHERE user_id=$1 AND id=(SELECT id FROM saved_cards WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1)`,
        [userId],
      );
    }
  }

  static async setDefaultCard(cardId, userId) {
    return await this.transaction(async (client) => {
      await client.query(
        "UPDATE saved_cards SET is_default=false WHERE user_id=$1",
        [userId],
      );
      const result = await client.query(
        "UPDATE saved_cards SET is_default=true WHERE id=$1 AND user_id=$2 RETURNING id",
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
        "SELECT id, delivery_fee, driver_payout, user_id, status FROM orders WHERE id=$1",
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
        `UPDATE orders SET status='paid', delivery_payment_method='cash',
         delivery_payment_status='pending_collection', is_cash_delivery=true, updated_at=NOW()
         WHERE id=$1`,
        [orderId],
      );

      await client.query(
        `INSERT INTO payments (order_id, user_id, amount, method, provider, status, type)
         VALUES ($1,$2,$3,'cash','cash_on_delivery','pending_collection','delivery')`,
        [orderId, userId, order.delivery_fee],
      );

      if (io) {
        io.to("driver_pool").emit("new_order_available", {
          orderId,
          isCashDelivery: true,
          deliveryFee: order.delivery_fee,
          cashNote: `Cash delivery — collect R${parseFloat(order.driver_payout || 0).toFixed(2)} on arrival`,
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
