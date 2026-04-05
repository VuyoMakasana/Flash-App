const db = require("../config/database");
const paystackService = require("./paystackService");

class RefundService {
  static async refundOrderPayment(orderId, userId, reason = "customer_cancellation") {
    const client = await db.connect();
    let refundRow;
    let order;
    let payment;

    try {
      await client.query("BEGIN");

      const orderResult = await client.query(
        `SELECT id, user_id, payment_method, payment_status, total
         FROM orders
         WHERE id = $1
         FOR UPDATE`,
        [orderId],
      );

      if (!orderResult.rows.length) {
        throw new Error("Order not found");
      }

      order = orderResult.rows[0];
      if (String(order.user_id) !== String(userId)) {
        throw new Error("Not your order");
      }

      const existingCompleted = await client.query(
        `SELECT *
         FROM payment_refunds
         WHERE order_id = $1 AND status = 'completed'
         ORDER BY created_at DESC
         LIMIT 1`,
        [orderId],
      );
      if (existingCompleted.rows.length) {
        await client.query("COMMIT");
        return existingCompleted.rows[0];
      }

      if (!["card", "payflex"].includes(order.payment_method || "")) {
        throw new Error("Order payment method does not support automated refund");
      }

      if (order.payment_status !== "paid") {
        throw new Error("Order is not in a refundable paid state");
      }

      const paymentResult = await client.query(
        `SELECT id, provider, provider_transaction_id, amount
         FROM payments
         WHERE order_id = $1
           AND status = 'paid'
           AND provider_transaction_id IS NOT NULL
         ORDER BY created_at DESC
         LIMIT 1`,
        [orderId],
      );

      if (!paymentResult.rows.length) {
        throw new Error("No provider transaction found for refund");
      }

      payment = paymentResult.rows[0];

      const createRefund = await client.query(
        `INSERT INTO payment_refunds (order_id, user_id, payment_id, amount, provider, status, reason)
         VALUES ($1, $2, $3, $4, $5, 'processing', $6)
         RETURNING *`,
        [orderId, userId, payment.id, payment.amount, payment.provider, reason],
      );

      refundRow = createRefund.rows[0];
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    try {
      const amountInCents = Math.round(parseFloat(payment.amount || order.total || 0) * 100);
      const providerResult = await paystackService.refundTransaction(
        payment.provider_transaction_id,
        amountInCents,
        reason,
      );

      if (!providerResult?.status) {
        throw new Error(providerResult?.message || "Refund provider request failed");
      }

      const refundReference = providerResult.data?.refund_reference || providerResult.data?.reference || null;
      await db.query(
        `UPDATE payment_refunds
         SET status = 'completed', refund_reference = $2, provider_response = $3::jsonb, updated_at = NOW(), completed_at = NOW()
         WHERE id = $1`,
        [refundRow.id, refundReference, JSON.stringify(providerResult)],
      );

      await db.query(
        `UPDATE orders
         SET payment_status = 'refunded', updated_at = NOW()
         WHERE id = $1`,
        [orderId],
      );

      const finalRefund = await db.query(
        `SELECT * FROM payment_refunds WHERE id = $1`,
        [refundRow.id],
      );

      return finalRefund.rows[0];
    } catch (err) {
      await db.query(
        `UPDATE payment_refunds
         SET status = 'failed', provider_response = $2::jsonb, updated_at = NOW()
         WHERE id = $1`,
        [refundRow.id, JSON.stringify({ error: err.message })],
      ).catch(() => null);

      throw err;
    }
  }
}

module.exports = RefundService;
