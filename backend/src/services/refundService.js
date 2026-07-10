const db = require("../config/database");
const paystackService = require("./paystackService");

class RefundService {
  // overrideAmount (optional): refund less than the full payment amount —
  // used by the returns feature to net the return fee out of the refund
  // (refund_amount = subtotal - fee) instead of refunding the full original
  // payment. Every existing caller (order-cancellation refunds) omits this
  // argument entirely, so `overrideAmount == null` preserves the exact
  // original full-amount behavior unchanged.
  static async refundOrderPayment(orderId, userId, reason = "customer_cancellation", overrideAmount = null) {
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

      // Guards against 'processing' too, not just 'completed' — a refund now
      // stays 'processing' for as long as Paystack takes to actually confirm
      // it (real refunds are asynchronous; a live test call came back
      // "pending" with a multi-day expected_at), so a retried cancellation
      // request (client retry, or this same cron tick re-running) hitting
      // this function again while the first attempt is still in flight would
      // otherwise submit a second refund against Paystack for the same
      // order. 'failed' is intentionally excluded so a genuinely failed
      // refund can be retried.
      const existingRefund = await client.query(
        `SELECT *
         FROM payment_refunds
         WHERE order_id = $1 AND status IN ('processing', 'completed')
         ORDER BY created_at DESC
         LIMIT 1`,
        [orderId],
      );
      if (existingRefund.rows.length) {
        await client.query("COMMIT");
        return existingRefund.rows[0];
      }

      if (order.payment_method !== "card") {
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

      // A caller-supplied overrideAmount can only ever reduce the refund
      // below what was actually paid — never increase it. Falls back to the
      // full payment amount when not provided (overrideAmount == null),
      // which is what every existing caller does.
      let refundAmount = parseFloat(payment.amount);
      if (overrideAmount != null) {
        const parsedOverride = parseFloat(overrideAmount);
        if (Number.isNaN(parsedOverride) || parsedOverride <= 0 || parsedOverride > refundAmount) {
          throw new Error("Invalid refund amount");
        }
        refundAmount = parsedOverride;
      }

      const createRefund = await client.query(
        `INSERT INTO payment_refunds (order_id, user_id, payment_id, amount, provider, status, reason)
         VALUES ($1, $2, $3, $4, $5, 'processing', $6)
         RETURNING *`,
        [orderId, userId, payment.id, refundAmount, payment.provider, reason],
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
      const amountInCents = Math.round(parseFloat(refundRow.amount || payment.amount || order.total || 0) * 100);
      const providerResult = await paystackService.refundTransaction(
        payment.provider_transaction_id,
        amountInCents,
        reason,
      );

      if (!providerResult?.status) {
        throw new Error(providerResult?.message || "Refund provider request failed");
      }

      // Paystack's real /refund response has no `reference`/`refund_reference`
      // field at all (confirmed against a live test-mode call) — the refund's
      // own identifier is `data.id`. This is also the value that later
      // refund.processed/refund.failed webhooks carry, so it's what
      // webhookController matches against to close the loop.
      const refundReference = providerResult.data?.id != null ? String(providerResult.data.id) : null;

      // Paystack's refund is asynchronous — accepting the request (this HTTP
      // response) is not the same as the refund actually completing. A live
      // test call came back with status: "pending" and an expected_at days
      // out, not "done". Marking the order 'refunded' here would tell the
      // customer/store their money is back before Paystack has confirmed
      // that's true. 'refund_pending' is the accurate interim state;
      // webhookController's refund.processed/refund.failed handlers move it
      // to its final 'refunded' or flag it for manual attention.
      await db.query(
        `UPDATE payment_refunds
         SET refund_reference = $2, provider_response = $3::jsonb, updated_at = NOW()
         WHERE id = $1`,
        [refundRow.id, refundReference, JSON.stringify(providerResult)],
      );

      await db.query(
        `UPDATE orders
         SET payment_status = 'refund_pending', updated_at = NOW()
         WHERE id = $1`,
        [orderId],
      );

      const updatedRefund = await db.query(
        `SELECT * FROM payment_refunds WHERE id = $1`,
        [refundRow.id],
      );

      return updatedRefund.rows[0];
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

  // Shared by webhookController's refund.processed/refund.failed handlers and
  // paymentReconciliationJob's polling fallback — one place that actually
  // moves a refund to its final state, so both paths can't disagree on how
  // that's done. Matches on refund_reference (Paystack's refund id) first,
  // falling back to the underlying payment's provider_transaction_id in case
  // the reference wasn't captured for some reason.
  //
  // outcome must be 'completed' or 'failed'. Idempotent: if the refund row is
  // already in a terminal state, this is a no-op (both the webhook and the
  // polling fallback can end up racing to finalize the same refund).
  //
  // webhookEvent (optional) is { id, event } — when passed, the webhook_events
  // idempotency marker is inserted inside this SAME transaction as the state
  // change, so a failure rolls back both together and a Paystack webhook
  // retry can safely retry the whole thing. Recording the marker in a
  // separate, already-committed query would let a later failure in this
  // function get silently swallowed on retry — the duplicate-event check
  // would skip reprocessing even though finalization never actually happened.
  static async finalizeRefund(refundReference, transactionProviderId, outcome, providerResponsePayload, webhookEvent = null) {
    if (!["completed", "failed"].includes(outcome)) {
      throw new Error(`Invalid refund outcome: ${outcome}`);
    }
    if (!refundReference && !transactionProviderId) {
      return null;
    }

    const client = await db.connect();
    try {
      await client.query("BEGIN");

      if (webhookEvent?.id) {
        try {
          await client.query(
            `INSERT INTO webhook_events (paystack_event_id, event_type) VALUES ($1, $2)`,
            [String(webhookEvent.id), webhookEvent.event || "unknown"],
          );
        } catch (dupErr) {
          if (dupErr.code === "23505") {
            await client.query("ROLLBACK");
            return { alreadyFinalized: true, duplicateEvent: true };
          }
          throw dupErr;
        }
      }

      const row = await client.query(
        `SELECT pr.id, pr.order_id, pr.status
         FROM payment_refunds pr
         LEFT JOIN payments p ON p.id = pr.payment_id
         WHERE (pr.refund_reference = $1 AND $1::text IS NOT NULL)
            OR (p.provider_transaction_id = $2 AND $2::text IS NOT NULL)
         ORDER BY pr.created_at DESC
         LIMIT 1
         FOR UPDATE`,
        [refundReference, transactionProviderId],
      );

      if (!row.rows.length) {
        await client.query("ROLLBACK");
        return null;
      }

      const { id: refundId, order_id: orderId, status: currentStatus } = row.rows[0];

      if (currentStatus === "completed" || currentStatus === "failed") {
        await client.query("ROLLBACK");
        return { orderId, alreadyFinalized: true };
      }

      await client.query(
        `UPDATE payment_refunds
         SET status = $2,
             provider_response = $3::jsonb,
             updated_at = NOW(),
             completed_at = CASE WHEN $2 = 'completed' THEN NOW() ELSE completed_at END
         WHERE id = $1`,
        [refundId, outcome, JSON.stringify(providerResponsePayload)],
      );

      await client.query(
        `UPDATE orders SET payment_status = $2, updated_at = NOW() WHERE id = $1`,
        [orderId, outcome === "completed" ? "refunded" : "refund_failed"],
      );

      await client.query("COMMIT");
      return { orderId, alreadyFinalized: false };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}

module.exports = RefundService;
