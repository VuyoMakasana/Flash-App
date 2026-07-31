const db = require("../config/database");
const paystackService = require("./paystackService");
const RefundService = require("./refundService");
const { updateOrderStatus } = require("./orderStateMachineService");

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

        // No longer transitions straight to waiting_for_driver / auto-
        // assigns below -- a paid order now waits for a real store
        // accept/reject (docs/audits/FLASH_STORE_ADMIN_DESIGN.md §0)
        // before driver matching begins, same as the webhook/cash paths
        // this job exists to catch missed webhooks for.
        try {
          await updateOrderStatus(order.id, "pending_store_acceptance", {
            actorId: "reconciliation_job",
            actorRole: "system",
            io,
          });
        } catch (_) {}
      }
    } catch (err) {
      console.warn(`[Reconciliation] orderId=${order.id} failed: ${err.message}`);
    }
  }
}

// Polling fallback for refund.processed/refund.failed webhooks — mirrors
// reconcilePendingPayments' role for charge.success above (webhook-primary,
// poll as a safety net for a missed webhook). A refund stuck 'processing'
// for over 10 minutes gets its real status pulled directly from Paystack and
// finalized through the same RefundService.finalizeRefund() the webhook
// handlers use, so a dropped webhook doesn't leave a refund silently
// unresolved forever.
async function reconcileStuckRefunds() {
  const result = await db.query(
    `SELECT id, refund_reference
     FROM payment_refunds
     WHERE status = 'processing'
       AND refund_reference IS NOT NULL
       AND updated_at < NOW() - INTERVAL '10 minutes'
     ORDER BY updated_at ASC
     LIMIT 50`,
  );

  for (const refund of result.rows) {
    try {
      const fetched = await paystackService.fetchRefund(refund.refund_reference);
      const status = fetched?.data?.status;

      if (status === "processed") {
        await RefundService.finalizeRefund(refund.refund_reference, null, "completed", fetched);
      } else if (status === "failed") {
        await RefundService.finalizeRefund(refund.refund_reference, null, "failed", fetched);
      }
      // pending/processing: still in flight, leave it for the next poll.
    } catch (err) {
      console.warn(`[Reconciliation] refund poll failed for refundId=${refund.refund_reference}: ${err.message}`);
    }
  }
}

// Cancelled card orders whose payment_status is still stuck at 'paid' mean a
// refund was never actually issued — either RefundService.refundOrderPayment
// was never called at all (an exception somewhere before it), or it was
// called and failed outright before Paystack even accepted the request (a
// payment_refunds row exists with status='failed'). Nothing else retries
// this, so without it a customer's money would be stuck indefinitely purely
// because of a transient failure at the moment their order was cancelled.
async function reconcileMissingRefunds(io) {
  const result = await db.query(
    `SELECT id, user_id
     FROM orders
     WHERE status = 'cancelled'
       AND payment_method = 'card'
       AND payment_status = 'paid'
       AND updated_at < NOW() - INTERVAL '5 minutes'
     LIMIT 50`,
  );

  for (const order of result.rows) {
    try {
      await RefundService.refundOrderPayment(order.id, order.user_id, "reconciliation_retry");
      console.log(`[Reconciliation] Retried missing refund for cancelled order ${order.id}`);
    } catch (err) {
      console.warn(`[Reconciliation] Refund retry failed for order ${order.id}: ${err.message}`);
    }
  }
}

module.exports = {
  reconcilePendingPayments,
  reconcileStuckRefunds,
  reconcileMissingRefunds,
};
