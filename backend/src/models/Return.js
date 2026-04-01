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

  static async approveReturn(returnId, adminId) {
    return await this.transaction(async (client) => {
      const returnResult = await client.query(
        `SELECT rr.*, o.user_id, o.store_id, o.delivery_fee,
                o.pickup_address, o.dropoff_address,
                o.pickup_lat, o.pickup_lng, o.dropoff_lat, o.dropoff_lng
         FROM return_requests rr
         JOIN orders o ON o.id = rr.order_id
         WHERE rr.id = $1
         FOR UPDATE`,
        [returnId],
      );

      if (!returnResult.rows.length) {
        throw new Error("Return not found");
      }

      const ret = returnResult.rows[0];
      if (ret.status !== "requested") {
        throw new Error("Return request is not awaiting approval");
      }

      const originalOrder = await client.query(
        `SELECT order_number, subtotal, delivery_fee
         FROM orders WHERE id = $1`,
        [ret.order_id],
      );

      const source = originalOrder.rows[0];
      const returnOrderNumber = `${source.order_number}-RET-${Date.now().toString(36).toUpperCase()}`;
      const returnDeliveryFee = parseFloat(ret.delivery_fee || 90);
      const driverPayout = Math.round((returnDeliveryFee * 0.75 + 15) * 100) / 100;

      const createdOrder = await client.query(
        `INSERT INTO orders (
          order_number, user_id, status, delivery_mode, time_slot,
          subtotal, delivery_fee, total, driver_payout,
          store_id, payment_method, payment_status,
          delivery_payment_status, store_paid, driver_paid,
          is_return_order, parent_order_id,
          pickup_address, dropoff_address,
          pickup_lat, pickup_lng, dropoff_lat, dropoff_lng
        ) VALUES (
          $1, $2, 'waiting_for_driver', 'fleet', 'asap',
          0, $3, $3, $4,
          $5, 'store_account', 'paid',
          'pending_driver', true, false,
          true, $6,
          $7, $8,
          $9, $10, $11, $12
        ) RETURNING id, order_number, status`,
        [
          returnOrderNumber,
          ret.user_id,
          returnDeliveryFee,
          driverPayout,
          ret.store_id || null,
          ret.order_id,
          ret.dropoff_address,
          ret.pickup_address,
          ret.dropoff_lat,
          ret.dropoff_lng,
          ret.pickup_lat,
          ret.pickup_lng,
        ],
      );

      await client.query(
        `UPDATE return_requests
         SET status = 'approved',
             approved_at = NOW(),
             approved_by = $2,
             return_order_id = $3,
             updated_at = NOW()
         WHERE id = $1`,
        [returnId, adminId || null, createdOrder.rows[0].id],
      );

      return {
        returnId,
        status: "approved",
        returnOrder: createdOrder.rows[0],
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
