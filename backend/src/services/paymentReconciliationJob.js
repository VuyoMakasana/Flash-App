const db = require("../config/database");
const paystackService = require("./paystackService");
const RefundService = require("./refundService");
const { updateOrderStatus, notifyAdminNewOrderPendingAcceptance } = require("./orderStateMachineService");
const { applyOrderCharge } = require("./orderChargeService");

// Step 1 (#102): how long an unpaid card order keeps its reserved stock
// before a definite "not paid" answer from Paystack cancels it.
const STALE_PAYMENT_MINUTES = 60;

// Moves a just-paid order into store acceptance. Same follow-on steps the
// job always ran after marking an order paid.
async function advancePaidOrder(orderId, io) {
  try {
    await updateOrderStatus(orderId, "paid", {
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
    const updated = await updateOrderStatus(orderId, "pending_store_acceptance", {
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

// Catches a missed charge.success webhook. Step 1 (#102): a success found
// here goes through the SAME orderChargeService as the webhook, so it is
// recorded against the order or refunded, never ignored. That includes M8's
// amount check (#94): a wrong amount is refunded, not marked paid.
// 'failed' is included: a customer can retry after a failed attempt.
async function reconcilePendingPayments(io) {
  const result = await db.query(
    `SELECT id, user_id, payment_status, paystack_reference, payment_method, total, updated_at
     FROM orders
     WHERE payment_status IN ('pending', 'failed')
       AND paystack_reference IS NOT NULL
       AND status <> 'cancelled'
       AND updated_at < NOW() - INTERVAL '2 minutes'
     ORDER BY updated_at ASC
     LIMIT 50`,
  );

  for (const order of result.rows) {
    try {
      const tx = await paystackService.fetchTransactionStatus(order.paystack_reference);
      if (tx.status !== "success") continue;

      const applied = await applyOrderCharge({
        orderId: order.id,
        reference: order.paystack_reference,
        transactionId: tx.transactionId,
        amount: tx.amount,
        currency: tx.currency,
      }, { source: "reconciliation" });

      if (applied.outcome === "paid") {
        await advancePaidOrder(order.id, io);
      }
    } catch (err) {
      console.warn(`[Reconciliation] orderId=${order.id} failed: ${err.message}`);
    }
  }
}

// Step 1 (#102), founder rule: an unpaid card order is cancelled only on a
// DEFINITE answer from Paystack that it wasn't paid ('failed', 'abandoned',
// 'reversed'), and only after STALE_PAYMENT_MINUTES. No answer, a network
// error or an in-flight status never cancels anything; the order is looked
// at again on the next run. Cancelling goes through updateOrderStatus, which
// restocks the items exactly once (charge.failed no longer restocks).
//
// If the customer pays that Paystack page after all, the late charge.success
// lands on a cancelled order and orderChargeService refunds it in full with
// an admin alert.
async function cancelStalePendingPayments(io, { staleMinutes = STALE_PAYMENT_MINUTES } = {}) {
  const result = await db.query(
    `SELECT id, user_id, paystack_reference
     FROM orders
     WHERE status IN ('created', 'payment_pending')
       AND payment_status IN ('pending', 'failed')
       AND paystack_reference IS NOT NULL
       AND updated_at < NOW() - ($1 || ' minutes')::interval
     ORDER BY updated_at ASC
     LIMIT 50`,
    [staleMinutes],
  );

  let cancelled = 0;
  for (const order of result.rows) {
    try {
      const tx = await paystackService.fetchTransactionStatus(order.paystack_reference);
      if (!tx.definite) {
        console.warn(
          `[Reconciliation] stale payment on order ${order.id} left as is: no definite Paystack answer `
          + `(${tx.status || tx.error || "none"})`,
        );
        continue;
      }
      if (tx.status === "success") continue; // reconcilePendingPayments records it

      const client = await db.connect();
      let didCancel = false;
      try {
        await client.query("BEGIN");
        // Re-check under the lock: the reference must still be the one
        // Paystack answered about, and the order must still be unpaid.
        const locked = await client.query(
          `SELECT status, payment_status, paystack_reference FROM orders WHERE id = $1 FOR UPDATE`,
          [order.id],
        );
        const row = locked.rows[0];
        if (row
          && ["created", "payment_pending"].includes(row.status)
          && ["pending", "failed"].includes(row.payment_status)
          && row.paystack_reference === order.paystack_reference) {
          await client.query(
            `INSERT INTO order_cancellations (order_id, cancelled_by_role, reason, refund_mode)
             VALUES ($1, 'system', 'payment_not_completed_timeout', 'full_refund')`,
            [order.id],
          );
          await updateOrderStatus(order.id, "cancelled", {
            actorId: "reconciliation_job", actorRole: "system", io, externalClient: client,
          });
          didCancel = true;
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }

      if (didCancel) {
        cancelled += 1;
        console.log(
          `[Reconciliation] Cancelled unpaid order ${order.id} (Paystack: ${tx.status}); items restocked`,
        );
        if (io) {
          io.to(`user:${order.user_id}`).emit("order_update", {
            orderId: order.id,
            status: "cancelled",
            message: "Your order was cancelled because the payment wasn't completed. You haven't been charged.",
          });
        }
      }
    } catch (err) {
      console.warn(`[Reconciliation] stale payment check failed for order ${order.id}: ${err.message}`);
    }
  }
  return { cancelled };
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
  // PR G1 (#106), review of #107: an attempt Paystack ACCEPTED but whose
  // refund id couldn't be saved carries a marker (RefundService.
  // submitToPaystack). Adopt that id, so the normal polling finalizes it,
  // instead of failing it: failing it would allow a second refund of money
  // already on its way back.
  const adopted = await db.query(
    `UPDATE payment_refunds
     SET refund_reference = provider_response->>'refundId', updated_at = NOW()
     WHERE status = 'processing'
       AND refund_reference IS NULL
       AND provider_response->>'acceptedByPaystack' = 'true'
       AND provider_response->>'refundId' IS NOT NULL
     RETURNING id, order_id`,
  );
  for (const row of adopted.rows) {
    console.warn(`[Reconciliation] Adopted Paystack's refund id for accepted attempt ${row.id} (order ${row.order_id})`);
  }

  const result = await db.query(
    `UPDATE payment_refunds
     SET status = 'failed',
         provider_response = COALESCE(provider_response, '{}'::jsonb) || '{"orphaned": true}'::jsonb,
         updated_at = NOW()
     WHERE status = 'processing'
       AND refund_reference IS NULL
       AND COALESCE(provider_response->>'acceptedByPaystack', '') <> 'true'
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

// The latest cancellation record for each order decides how much goes back:
// the full payment, or only the customer's share of a split cancellation.
const CANCELLED_ORDER_REFUND_SQL = `
  SELECT o.id, o.user_id, oc.refund_mode, oc.customer_item_refund, oc.delivery_fee_refunded
  FROM orders o
  LEFT JOIN LATERAL (
    SELECT refund_mode, customer_item_refund, delivery_fee_refunded
    FROM order_cancellations
    WHERE order_id = o.id
    ORDER BY created_at DESC
    LIMIT 1
  ) oc ON true`;

// Retries one cancelled card order's refund.
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
// path in this codebase), so this joins to the most recent cancellation
// record for each order and only overrides the amount for a genuine split.
//
// options.manual (Step 1, #102): an admin's manual retry, past the cap.
async function retryCancelledOrderRefund(order, { manual = false, reason = "reconciliation_retry" } = {}) {
  const isSplit = order.refund_mode === "pre_pickup_split" || order.refund_mode === "store_arrival_split";
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
      return null;
    }
  }
  return RefundService.refundOrderPayment(order.id, order.user_id, reason, overrideAmount, { manual });
}

// Admin "Retry refund" (Step 1, #102): one order, past the automatic cap.
async function manualRetryOrderRefund(orderId) {
  const r = await db.query(`${CANCELLED_ORDER_REFUND_SQL}
    WHERE o.id = $1 AND o.status = 'cancelled' AND o.payment_method = 'card'
      AND o.payment_status IN ('paid', 'refund_failed')`, [orderId]);
  if (!r.rows.length) throw new Error("This order has no refund waiting to be retried");
  return retryCancelledOrderRefund(r.rows[0], { manual: true, reason: "admin_manual_retry" });
}

// Cancelled card orders whose money hasn't gone back: payment_status still
// 'paid' (a refund was never issued, or failed before Paystack accepted it)
// or 'refund_failed' (Paystack declined it). Step 1 (#102), founder rule:
// retried automatically at most MAX_AUTOMATIC_REFUND_ATTEMPTS times in
// total; after that the order is skipped (an admin was alerted on the last
// failure) until someone retries it by hand.
async function reconcileMissingRefunds(io) {
  const result = await db.query(`${CANCELLED_ORDER_REFUND_SQL}
     WHERE o.status = 'cancelled'
       AND o.payment_method = 'card'
       AND o.payment_status IN ('paid', 'refund_failed')
       AND o.updated_at < NOW() - INTERVAL '5 minutes'
       AND NOT EXISTS (
         SELECT 1 FROM payment_refunds pr
         WHERE pr.order_id = o.id AND pr.status IN ('processing', 'completed')
       )
       AND (
         SELECT COUNT(*) FROM payment_refunds pr
         LEFT JOIN payments p ON p.id = pr.payment_id
         WHERE pr.order_id = o.id AND pr.status = 'failed'
           AND COALESCE(p.status, '') NOT IN ('${RefundService.STRAY}', '${RefundService.STRAY_REFUNDED}')
       ) < $1
     LIMIT 50`, [RefundService.MAX_AUTOMATIC_REFUND_ATTEMPTS]);

  for (const order of result.rows) {
    try {
      const refund = await retryCancelledOrderRefund(order);
      if (refund) console.log(`[Reconciliation] Retried missing refund for cancelled order ${order.id}`);
    } catch (err) {
      console.warn(`[Reconciliation] Refund retry failed for order ${order.id}: ${err.message}`);
    }
  }
}

// Step 1 (#102): stray charges (late, duplicate or wrong-amount payments)
// whose automatic refund didn't go through, e.g. Paystack was unreachable
// or the process restarted right after recording the charge. Same cap.
async function reconcileStrayRefunds() {
  const result = await db.query(
    `SELECT p.id
     FROM payments p
     WHERE p.status = $1
       AND p.order_id IS NOT NULL
       AND p.created_at < NOW() - INTERVAL '5 minutes'
       AND NOT EXISTS (
         SELECT 1 FROM payment_refunds pr
         WHERE pr.payment_id = p.id AND pr.status IN ('processing', 'completed')
       )
       AND (SELECT COUNT(*) FROM payment_refunds pr WHERE pr.payment_id = p.id AND pr.status = 'failed') < $2
     ORDER BY p.created_at ASC
     LIMIT 50`,
    [RefundService.STRAY, RefundService.MAX_AUTOMATIC_REFUND_ATTEMPTS],
  );

  for (const row of result.rows) {
    try {
      await RefundService.refundStrayPayment(row.id);
      console.log(`[Reconciliation] Retried refund of stray payment ${row.id}`);
    } catch (err) {
      console.warn(`[Reconciliation] stray refund retry failed for payment ${row.id}: ${err.message}`);
    }
  }
}

module.exports = {
  reconcilePendingPayments,
  cancelStalePendingPayments,
  reconcileStuckRefunds,
  reconcileOrphanedProcessingRefunds,
  reconcileMissingRefunds,
  reconcileStrayRefunds,
  retryCancelledOrderRefund,
  manualRetryOrderRefund,
  STALE_PAYMENT_MINUTES,
};
