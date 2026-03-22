const BaseModel = require("./BaseModel");

class Return extends BaseModel {
  static async requestReturn(orderId, userId, reason, io) {
    return await this.transaction(async (client) => {
      const order = await client.query(
        "SELECT id, status, user_id, subtotal, delivery_fee FROM orders WHERE id=$1",
        [orderId],
      );

      if (!order.rows.length) {
        throw new Error("Order not found");
      }

      if (order.rows[0].user_id !== userId) {
        throw new Error("Not your order");
      }

      if (!["delivered", "completed"].includes(order.rows[0].status)) {
        throw new Error("Can only return delivered orders");
      }

      const result = await client.query(
        `INSERT INTO return_requests (order_id, user_id, reason) VALUES ($1,$2,$3)
         ON CONFLICT (order_id) DO NOTHING RETURNING *`,
        [orderId, userId, reason || null],
      );

      if (!result.rows.length) {
        throw new Error("Return already requested");
      }

      return result.rows[0];
    });
  }

  static async pickupReturn(returnId, driverId, io) {
    return await this.transaction(async (client) => {
      const returnResult = await client.query(
        `SELECT rr.*, o.subtotal, o.user_id FROM return_requests rr
         JOIN orders o ON o.id = rr.order_id
         WHERE rr.id=$1 AND rr.status='requested'`,
        [returnId],
      );

      if (!returnResult.rows.length) {
        throw new Error("Return not found or already processed");
      }

      const ret = returnResult.rows[0];

      await client.query(
        `UPDATE return_requests SET driver_id=$1, status='picked_up', picked_up_at=NOW(), updated_at=NOW() WHERE id=$2`,
        [driverId, returnId],
      );

      const creditAmount = parseFloat(ret.subtotal);
      await client.query(
        `INSERT INTO store_credits (user_id, return_id, amount, balance, reason, expires_at)
         VALUES ($1,$2,$3,$3,'Return credit — reorder any time',NOW() + INTERVAL '90 days')`,
        [ret.user_id, returnId, creditAmount],
      );

      await client.query(
        `UPDATE return_requests SET credit_issued=true, credit_amount=$1, updated_at=NOW() WHERE id=$2`,
        [creditAmount, returnId],
      );

      if (io) {
        io.to(`user:${ret.user_id}`).emit("return_credit_issued", {
          returnId,
          creditAmount,
          message: `R${creditAmount.toFixed(2)} store credit added to your account. Use it on your next order!`,
        });
      }

      return {
        success: true,
        creditIssued: creditAmount,
        message: `Return picked up. R${creditAmount.toFixed(2)} instant credit issued to customer.`,
      };
    });
  }

  static async getCredits(userId) {
    const result = await this.query(
      `SELECT id, amount, balance, reason, expires_at, created_at
       FROM store_credits
       WHERE user_id=$1 AND balance > 0 AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY created_at DESC`,
      [userId],
    );

    const total = result.rows.reduce(
      (sum, c) => sum + parseFloat(c.balance),
      0,
    );
    return { credits: result.rows, totalBalance: total.toFixed(2) };
  }

  static async getUserReturns(userId) {
    const result = await this.query(
      `SELECT rr.*, o.order_number, o.subtotal FROM return_requests rr
       JOIN orders o ON o.id = rr.order_id
       WHERE rr.user_id=$1 ORDER BY rr.created_at DESC`,
      [userId],
    );
    return result.rows;
  }
}

module.exports = Return;
