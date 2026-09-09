const db = require("../config/database");
const paystackService = require("./paystackService");
const RefundService = require("./refundService");
const { updateOrderStatus, notifyAdminNewOrderPendingAcceptance } = require("./orderStateMachineService");

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
          const updated = await updateOrderStatus(order.id, "pending_store_acceptance", {
            actorId: "reconciliation_job",
            actorRole: "system",
            io,
          });
          // §2.12 audit — same reasoning as webhookController's own call
          // site for this exact transition: a new order reaching
          // pending_store_acceptance previously had zero admin-facing
          // signal. Best-effort.
          notifyAdminNewOrderPendingAcceptance(updated, io);
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
//
// §2.9 audit addition: a SEPARATE, narrower orphan case this polling can't
// cover — a payment_refunds row can be committed at status='processing'
// with refund_reference still NULL if the process crashes (redeploy, OOM)
// after that commit but before the Paystack HTTP call ever returns (the
// reference is only ever set from Paystack's own response). There's
// nothing to poll for a row like that — Paystack was never told about the
// attempt, or its response never came back, so fetchRefund has no id to
// ask about. Before this fix, such a row was invisible to every
// reconciliation path forever: this function only looks at rows that
// already have a reference, and reconcileMissingRefunds' retry would just
// find this same 'processing' row via refundOrderPayment's own
// existing-refund short-circuit and return it unchanged. paystackService's
// own outbound Paystack timeout is 30 seconds, so any row still
// 'processing' with no reference minutes later is not a legitimately
// in-flight call — marking it 'failed' (excluded from that short-circuit)
// lets reconcileMissingRefunds pick the underlying order back up fresh on
// its next pass.
async function reconcileOrphanedProcessingRefunds() {
  const result = await db.query(
    `UPDATE payment_refunds
     SET status = 'failed',
         provider_response = COALESCE(provider_response, '{}'::jsonb) || '{"orphaned": true}'::jsonb,
         updated_at = NOW()
     WHERE status = 'processing'
       AND refund_reference IS NULL
       AND updated_at < NOW() - INTERVAL '5 minutes'
     RETURNING id, order_id`,
  );

  for (const row of result.rows) {
    console.warn(
      `[Reconciliation] Marked orphaned refund ${row.id} (order ${row.order_id}) as failed for retry — ` +
      `no Paystack reference was ever recorded, likely a process crash mid-request.`,
    );
  }

  return result;
}

async function reconcileStuckRefunds() {
  await reconcileOrphanedProcessingRefunds();

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
//
// §2.9 audit fix: this used to always retry with the FULL original payment
// amount, with no idea whether the original cancellation was a split
// compensation (driver_assigned/driver_arrived_store -- see
// computeCancellationSplit, orderController.js), where the *correct* refund
// is only the customer's share -- the store's and driver's withheld shares
// are meant to stay withheld. If that split refund's first attempt failed
// for any transient reason, this job would "fix" it 5 minutes later by
// refunding the FULL amount instead, silently overpaying the customer by
// exactly what the store/driver were supposed to keep. order_cancellations
// already stores everything needed to get this right (it's written in the
// same transaction as the cancellation itself, by every real cancellation
// path in this codebase), so this now joins to the most recent cancellation
// record for each order and only overrides the amount for a genuine split.
async function reconcileMissingRefunds(io) {
  const result = await db.query(
    `SELECT o.id, o.user_id, oc.refund_mode, oc.customer_item_refund, oc.delivery_fee_refunded
     FROM orders o
     LEFT JOIN LATERAL (
       SELECT refund_mode, customer_item_refund, delivery_fee_refunded
       FROM order_cancellations
       WHERE order_id = o.id
       ORDER BY created_at DESC
       LIMIT 1
     ) oc ON true
     WHERE o.status = 'cancelled'
       AND o.payment_method = 'card'
       AND o.payment_status = 'paid'
       AND o.updated_at < NOW() - INTERVAL '5 minutes'
     LIMIT 50`,
  );

  for (const order of result.rows) {
    try {
      const isSplit = order.refund_mode === 'pre_pickup_split' || order.refund_mode === 'store_arrival_split';
      let overrideAmount = null;
      if (isSplit) {
        overrideAmount = Math.round(
          (parseFloat(order.customer_item_refund || 0) + parseFloat(order.delivery_fee_refunded || 0)) * 100,
        ) / 100;
        if (!(overrideAmount > 0)) {
          // A split cancellation whose customer share is genuinely zero
          // (e.g. a zero delivery fee) was never meant to trigger a refund
          // at all -- cancelOrder itself only calls refundOrderPayment when
          // split.totalCustomerRefund > 0. Nothing to retry here.
          continue;
        }
      }

      await RefundService.refundOrderPayment(order.id, order.user_id, "reconciliation_retry", overrideAmount);
      console.log(`[Reconciliation] Retried missing refund for cancelled order ${order.id}`);
    } catch (err) {
      console.warn(`[Reconciliation] Refund retry failed for order ${order.id}: ${err.message}`);
    }
  }
}

module.exports = {
  reconcilePendingPayments,
  reconcileStuckRefunds,
  reconcileOrphanedProcessingRefunds,
  reconcileMissingRefunds,
};
