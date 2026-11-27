const db = require("../config/database");
const paystackService = require("./paystackService");
const { sendPaymentAlertEmail } = require("./emailService");

// Step 1 (#102), founder rule: a refund is tried automatically at most this
// many times. After the last failure an admin is alerted, and only a manual
// retry (admin panel) tries again.
const MAX_AUTOMATIC_REFUND_ATTEMPTS = 3;

// payments.status for a charge that must go back to the customer (Step 1,
// #102): a late payment on a cancelled order, a second payment for an order
// that was already paid, or a payment whose amount didn't match. Such a row
// is never 'paid', so refundOrderPayment and every total ignore it.
const STRAY = "stray";
const STRAY_REFUNDED = "stray_refunded";

function capError() {
  const err = new Error(
    `Refund not retried automatically: it already failed ${MAX_AUTOMATIC_REFUND_ATTEMPTS} times. Use a manual retry.`,
  );
  err.code = "REFUND_RETRY_CAP_REACHED";
  return err;
}

class RefundService {
  // Failed refund attempts for an order's own payment (stray charges are
  // counted separately, per payment).
  static async countFailedOrderRefunds(client, orderId) {
    const r = await client.query(
      `SELECT COUNT(*)::int AS n
       FROM payment_refunds pr
       LEFT JOIN payments p ON p.id = pr.payment_id
       WHERE pr.order_id = $1 AND pr.status = 'failed'
         AND COALESCE(p.status, '') NOT IN ('${STRAY}', '${STRAY_REFUNDED}')`,
      [orderId],
    );
    return r.rows[0]?.n || 0;
  }

  static async countFailedStrayRefunds(client, paymentId) {
    const r = await client.query(
      `SELECT COUNT(*)::int AS n FROM payment_refunds WHERE payment_id = $1 AND status = 'failed'`,
      [paymentId],
    );
    return r.rows[0]?.n || 0;
  }

  // Called after every recorded refund failure. Alerts admins once the
  // automatic attempts are used up (the 3rd automatic failure, and any
  // failed manual retry after that). Never throws: an alert problem must not
  // hide the refund failure itself.
  static async alertIfRefundRetriesExhausted({ orderId, paymentId = null, amount = null, stray = false }) {
    try {
      const failures = stray
        ? await RefundService.countFailedStrayRefunds(db, paymentId)
        : await RefundService.countFailedOrderRefunds(db, orderId);
      if (failures < MAX_AUTOMATIC_REFUND_ATTEMPTS) return false;
      console.error(
        `[Refund] CRITICAL: refund for order ${orderId}${stray ? ` (stray payment ${paymentId})` : ""} has failed `
        + `${failures} times. Automatic retries have stopped; it needs a manual retry in the admin panel.`,
      );
      await sendPaymentAlertEmail({
        title: "A refund keeps failing",
        orderId,
        amount,
        details: [
          `Failed attempts: ${failures}`,
          stray ? `This is a refund of an extra payment (payment ${paymentId}).` : "This is the order's refund.",
          "Automatic retries have stopped. Use Retry refund in the admin panel once the cause is fixed.",
        ],
      });
      return true;
    } catch (err) {
      console.error("[Refund] Could not send the refund alert:", err.message);
      return false;
    }
  }


  // overrideAmount (optional): refund less than the full payment amount —
  // used by the returns feature to net the return fee out of the refund
  // (refund_amount = subtotal - fee) instead of refunding the full original
  // payment. Every existing caller (order-cancellation refunds) omits this
  // argument entirely, so `overrideAmount == null` preserves the exact
  // original full-amount behavior unchanged.
  //
  // options.manual (Step 1, #102): an admin's manual retry. Automatic callers
  // stop after MAX_AUTOMATIC_REFUND_ATTEMPTS failures; a manual retry doesn't.
  static async refundOrderPayment(orderId, userId, reason = "customer_cancellation", overrideAmount = null, options = {}) {
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

      // 'refund_failed': Paystack declined an earlier refund (refund.failed
      // webhook). It can be tried again, within the same attempt cap.
      if (!["paid", "refund_failed"].includes(order.payment_status)) {
        throw new Error("Order is not in a refundable paid state");
      }

      if (!options.manual
        && await RefundService.countFailedOrderRefunds(client, orderId) >= MAX_AUTOMATIC_REFUND_ATTEMPTS) {
        throw capError();
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

      await RefundService.alertIfRefundRetriesExhausted({ orderId, amount: refundRow.amount });
      throw err;
    }
  }

  // Step 1 (#102): refunds a stray charge (payments.status = 'stray') in
  // full. Unlike refundOrderPayment it never changes the order's own
  // payment_status: the order may be cancelled, or genuinely paid by another
  // transaction that must stay paid. Same attempt cap and alert.
  static async refundStrayPayment(paymentId, options = {}) {
    const client = await db.connect();
    let refundRow;
    let payment;
    try {
      await client.query("BEGIN");
      const p = await client.query(
        `SELECT id, order_id, user_id, amount, provider, provider_transaction_id, status, metadata
         FROM payments WHERE id = $1 FOR UPDATE`,
        [paymentId],
      );
      if (!p.rows.length) throw new Error("Payment not found");
      payment = p.rows[0];
      if (payment.status !== STRAY) throw new Error("Payment is not awaiting a refund");
      if (!payment.order_id || !payment.user_id || !payment.provider_transaction_id) {
        throw new Error("Payment cannot be refunded automatically (missing order, user or transaction)");
      }

      const existing = await client.query(
        `SELECT * FROM payment_refunds
         WHERE payment_id = $1 AND status IN ('processing', 'completed')
         ORDER BY created_at DESC LIMIT 1`,
        [paymentId],
      );
      if (existing.rows.length) {
        await client.query("COMMIT");
        return existing.rows[0];
      }

      if (!options.manual
        && await RefundService.countFailedStrayRefunds(client, paymentId) >= MAX_AUTOMATIC_REFUND_ATTEMPTS) {
        throw capError();
      }

      const reason = `stray_charge:${payment.metadata?.strayReason || "unknown"}`;
      const created = await client.query(
        `INSERT INTO payment_refunds (order_id, user_id, payment_id, amount, provider, status, reason)
         VALUES ($1, $2, $3, $4, $5, 'processing', $6)
         RETURNING *`,
        [payment.order_id, payment.user_id, payment.id, payment.amount, payment.provider, reason],
      );
      refundRow = created.rows[0];
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    try {
      // No amount: Paystack refunds the whole transaction.
      const providerResult = await paystackService.refundTransaction(
        payment.provider_transaction_id,
        null,
        refundRow.reason,
      );
      if (!providerResult?.status) {
        throw new Error(providerResult?.message || "Refund provider request failed");
      }
      const refundReference = providerResult.data?.id != null ? String(providerResult.data.id) : null;
      await db.query(
        `UPDATE payment_refunds
         SET refund_reference = $2, provider_response = $3::jsonb, updated_at = NOW()
         WHERE id = $1`,
        [refundRow.id, refundReference, JSON.stringify(providerResult)],
      );
      const updated = await db.query(`SELECT * FROM payment_refunds WHERE id = $1`, [refundRow.id]);
      return updated.rows[0];
    } catch (err) {
      await db.query(
        `UPDATE payment_refunds
         SET status = 'failed', provider_response = $2::jsonb, updated_at = NOW()
         WHERE id = $1`,
        [refundRow.id, JSON.stringify({ error: err.message })],
      ).catch(() => null);
      await RefundService.alertIfRefundRetriesExhausted({
        orderId: payment.order_id, paymentId: payment.id, amount: payment.amount, stray: true,
      });
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
        `SELECT pr.id, pr.order_id, pr.status, pr.amount, pr.payment_id, p.status AS payment_status
         FROM payment_refunds pr
         LEFT JOIN payments p ON p.id = pr.payment_id
         WHERE (pr.refund_reference = $1 AND $1::text IS NOT NULL)
            OR (p.provider_transaction_id = $2 AND $2::text IS NOT NULL)
         ORDER BY pr.created_at DESC
         LIMIT 1
         FOR UPDATE OF pr`, // OF pr (#102): Postgres refuses FOR UPDATE on the nullable side of a LEFT JOIN
        [refundReference, transactionProviderId],
      );

      if (!row.rows.length) {
        await client.query("ROLLBACK");
        return null;
      }

      const {
        id: refundId, order_id: orderId, status: currentStatus, amount, payment_id: paymentId,
        payment_status: paymentStatus,
      } = row.rows[0];
      const stray = paymentStatus === STRAY || paymentStatus === STRAY_REFUNDED;

      if (currentStatus === "completed" || currentStatus === "failed") {
        await client.query("ROLLBACK");
        return { orderId, alreadyFinalized: true };
      }

      await client.query(
        // $2 is cast explicitly (#102): used both as the varchar column and
        // in a text comparison, Postgres refused it ("inconsistent types
        // deduced for parameter $2"), so no refund was ever finalized.
        `UPDATE payment_refunds
         SET status = $2::text,
             provider_response = $3::jsonb,
             updated_at = NOW(),
             completed_at = CASE WHEN $2::text = 'completed' THEN NOW() ELSE completed_at END
         WHERE id = $1`,
        [refundId, outcome, JSON.stringify(providerResponsePayload)],
      );

      if (stray) {
        // A stray charge's refund never changes the order (Step 1, #102).
        if (outcome === "completed") {
          await client.query(
            `UPDATE payments SET status = '${STRAY_REFUNDED}' WHERE id = $1`,
            [paymentId],
          );
        }
      } else {
        await client.query(
          `UPDATE orders SET payment_status = $2, updated_at = NOW() WHERE id = $1`,
          [orderId, outcome === "completed" ? "refunded" : "refund_failed"],
        );
      }

      await client.query("COMMIT");
      if (outcome === "failed") {
        await RefundService.alertIfRefundRetriesExhausted({ orderId, paymentId, amount, stray });
      }
      return { orderId, alreadyFinalized: false, stray };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}

RefundService.MAX_AUTOMATIC_REFUND_ATTEMPTS = MAX_AUTOMATIC_REFUND_ATTEMPTS;
RefundService.STRAY = STRAY;
RefundService.STRAY_REFUNDED = STRAY_REFUNDED;

module.exports = RefundService;
