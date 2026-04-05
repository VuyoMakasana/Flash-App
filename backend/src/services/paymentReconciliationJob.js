const db = require("../config/database");
const paystackService = require("./paystackService");
const { updateOrderStatus } = require("./orderStateMachineService");
const { autoAssignNearestDriver } = require("./fleetIntelligenceService");

async function reconcilePendingPayments(io) {
  const result = await db.query(
    `SELECT id, user_id, payment_status, paystack_reference, payment_method, updated_at
     FROM orders
     WHERE payment_status IN ('pending')
       AND paystack_reference IS NOT NULL
       AND updated_at < NOW() - INTERVAL '2 minutes'
     ORDER BY updated_at ASC
     LIMIT 50`,
  );

  for (const order of result.rows) {
    try {
      const verify = await paystackService.verifyPayment(order.paystack_reference, io, order.user_id);

      if (verify.paymentStatus === "paid") {
        continue;
      }

      if (verify.providerStatus === "success") {
        await db.query(
          `UPDATE orders
           SET payment_status = 'paid', payment_method = COALESCE(payment_method, 'card'),
               delivery_payment_status = 'pending_driver', store_paid = true, updated_at = NOW()
           WHERE id = $1`,
          [order.id],
        );

        try {
          await updateOrderStatus(order.id, "paid", {
            actorId: "reconciliation_job",
            actorRole: "system",
            io,
          });
        } catch (_) {}

        try {
          await updateOrderStatus(order.id, "waiting_for_driver", {
            actorId: "reconciliation_job",
            actorRole: "system",
            io,
          });
        } catch (_) {}

        await autoAssignNearestDriver(order.id, io).catch(() => null);
      }
    } catch (err) {
      console.warn(`[Reconciliation] orderId=${order.id} failed: ${err.message}`);
    }
  }
}

module.exports = {
  reconcilePendingPayments,
};
