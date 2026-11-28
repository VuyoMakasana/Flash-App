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

// Reasons that only the server writes, and that change how a refund is
// finalized. Free text from a customer or a store can never start with one
// (found in review of #107: a customer could type "admin_partial:" as their
// cancellation reason and stop the order's refund status from updating).
const SERVER_REASON_PREFIX = /^\s*(admin_|stray_charge:)/i;
function userReason(reason) {
  const text = String(reason ?? "");
  return SERVER_REASON_PREFIX.test(text) ? `note:${text}` : text;
}

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


  // PR G1 (#106), found in review: sends a recorded refund attempt to
  // Paystack. If Paystack refuses (or doesn't answer), the attempt is marked
  // failed and the 3-failure alert is checked. Once Paystack has ACCEPTED it,
  // the attempt is never marked failed: if saving the result locally fails,
  // the money is already on its way back, and a "failed" row would invite a
  // second refund. Instead admins are alerted with Paystack's refund id and
  // the error says not to refund again.
  static async submitToPaystack(refundRow, { transactionId, amountInCents, note, alert }) {
    let providerResult;
    try {
      providerResult = await paystackService.refundTransaction(transactionId, amountInCents, note);
      if (!providerResult?.status) {
        throw new Error(providerResult?.message || "Refund provider request failed");
      }
    } catch (err) {
      await db.query(
        `UPDATE payment_refunds
         SET status = 'failed', provider_response = $2::jsonb, updated_at = NOW()
         WHERE id = $1`,
        [refundRow.id, JSON.stringify({ error: err.message })],
      ).catch(() => null);
      await RefundService.alertIfRefundRetriesExhausted(alert);
      throw err;
    }

    // Paystack's refund id is data.id (its /refund response has no
    // reference field); the refund.processed/failed webhooks carry it too.
    const refundReference = providerResult.data?.id != null ? String(providerResult.data.id) : null;
    try {
      // The provider response is only replaced while the attempt is still
      // processing: if refund.processed/failed already finalized it, its
      // final answer is kept (review of #107).
      await db.query(
        `UPDATE payment_refunds
         SET refund_reference = $2,
             provider_response = CASE WHEN status = 'processing' THEN $3::jsonb ELSE provider_response END,
             updated_at = NOW()
         WHERE id = $1`,
        [refundRow.id, refundReference, JSON.stringify(providerResult)],
      );
    } catch (saveErr) {
      // Best effort, a second, smaller write: a durable "Paystack accepted
      // refund X" marker. reconcileOrphanedProcessingRefunds adopts the id
      // from it instead of failing the attempt, so the money already on its
      // way back is never refunded twice (review of #107).
      await db.query(
        `UPDATE payment_refunds
         SET provider_response = jsonb_build_object('acceptedByPaystack', true, 'refundId', $2::text)
         WHERE id = $1 AND status = 'processing'`,
        [refundRow.id, refundReference],
      ).catch(() => null);
      console.error(
        `[Refund] CRITICAL: Paystack ACCEPTED refund ${refundReference} for order ${alert.orderId} `
        + `(attempt ${refundRow.id}), but saving it failed: ${saveErr.message}. Do not refund this order again.`,
      );
      await sendPaymentAlertEmail({
        title: "A refund was sent but couldn't be saved",
        orderId: alert.orderId,
        amount: refundRow.amount,
        details: [
          `Paystack refund id: ${refundReference}`,
          `Error: ${saveErr.message}`,
          "Paystack accepted this refund. Do not refund the order again; check it in the Paystack dashboard.",
        ],
      }).catch(() => null);
      const err = new Error(
        `Paystack accepted the refund (id ${refundReference}), but saving it failed. `
        + "Don't refund again; check it in the Paystack dashboard.",
      );
      err.code = "REFUND_ACCEPTED_NOT_SAVED";
      throw err;
    }
    return { providerResult, refundReference };
  }

  // After Paystack accepted a FULL refund: the order shows refund_pending
  // until Paystack confirms. Never overwrites 'refunded' (the
  // refund.processed webhook can land before this line runs). Not fatal:
  // the refund itself is already accepted and recorded.
  //
  // Written only while THIS attempt is still processing: if Paystack's
  // refund.failed already finalized it (order 'refund_failed'), this must
  // not put the order back to pending (review of #107).
  static async markOrderRefundPending(orderId, refundId) {
    await db.query(
      `UPDATE orders SET payment_status = 'refund_pending', updated_at = NOW()
       WHERE id = $1 AND payment_status <> 'refunded'
         AND EXISTS (SELECT 1 FROM payment_refunds WHERE id = $2 AND status = 'processing')`,
      [orderId, refundId],
    ).catch((e) => console.error(`[Refund] could not mark order ${orderId} refund_pending:`, e.message));
  }

  // The saved attempt, re-read; falls back to what we know if the read fails.
  static async readAttempt(refundRow, refundReference) {
    try {
      const r = await db.query(`SELECT * FROM payment_refunds WHERE id = $1`, [refundRow.id]);
      return r.rows[0] || { ...refundRow, refund_reference: refundReference };
    } catch (_) {
      return { ...refundRow, refund_reference: refundReference };
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
        [orderId, userId, payment.id, refundAmount, payment.provider, userReason(reason)],
      );

      refundRow = createRefund.rows[0];
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    // Paystack's refund is asynchronous: accepting the request isn't the
    // refund completing (a live test call came back "pending", days out). So
    // the order shows 'refund_pending' until refund.processed/failed (or the
    // polling fallback) finalizes it.
    const amountInCents = Math.round(parseFloat(refundRow.amount || payment.amount || order.total || 0) * 100);
    const { refundReference } = await RefundService.submitToPaystack(refundRow, {
      transactionId: payment.provider_transaction_id,
      amountInCents,
      note: refundRow.reason,
      alert: { orderId, amount: refundRow.amount },
    });
    await RefundService.markOrderRefundPending(orderId, refundRow.id);
    return RefundService.readAttempt(refundRow, refundReference);
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

    // No amount: Paystack refunds the whole transaction.
    const { refundReference } = await RefundService.submitToPaystack(refundRow, {
      transactionId: payment.provider_transaction_id,
      amountInCents: null,
      note: refundRow.reason,
      alert: { orderId: payment.order_id, paymentId: payment.id, amount: payment.amount, stray: true },
    });
    return RefundService.readAttempt(refundRow, refundReference);
  }

  // PR G1 (#106), audit H7: an admin refunds a delivered or cancelled card
  // order, in full (amount null: everything still left) or in part, with a
  // typed reason. Every attempt is a payment_refunds row; a failure counts
  // for the 3-failure alert. Safety:
  //   - never more than what's left of what was paid (completed refunds on
  //     the payment are subtracted, in cents);
  //   - never a second refund while one is still in flight on the payment
  //     (a double click can't refund twice);
  //   - the order is locked for the whole decision.
  // A refund that leaves money unrefunded is recorded as 'admin_partial:' and
  // never changes the order's payment_status; one that clears the balance is
  // 'admin_full:' and behaves like every other full refund.
  static async adminRefund(orderId, { amount = null, reason, adminId } = {}) {
    const typedReason = String(reason ?? "").trim();
    if (!typedReason) throw new Error("Type a reason for the refund");
    if (typedReason.length > 500) throw new Error("Keep the reason under 500 characters");

    let requestedCents = null;
    if (amount !== null && amount !== undefined && String(amount).trim() !== "") {
      const text = String(amount).trim();
      const value = Number(text);
      if (!Number.isFinite(value) || value <= 0) throw new Error("The refund must be more than R0");
      if (Math.abs(value * 100 - Math.round(value * 100)) > 1e-6) {
        throw new Error("The refund amount can only have rands and cents");
      }
      requestedCents = Math.round(value * 100);
      // Found in review: a tiny positive amount (e.g. 0.000000001) passed the
      // checks above but rounds to 0 cents.
      if (requestedCents < 1) throw new Error("The refund must be more than R0");
    }

    const client = await db.connect();
    let refundRow;
    let payment;
    let isFull;
    let orderRow;
    try {
      await client.query("BEGIN");
      const o = await client.query(
        `SELECT id, user_id, status, payment_method, payment_status,
                (updated_at > NOW() - INTERVAL '5 minutes') AS changed_recently
         FROM orders WHERE id = $1 FOR UPDATE`,
        [orderId],
      );
      if (!o.rows.length) throw new Error("Order not found");
      orderRow = o.rows[0];
      if (!["delivered", "completed", "cancelled"].includes(orderRow.status)) {
        throw new Error("Only delivered or cancelled orders can be refunded here");
      }
      if (orderRow.payment_method !== "card") {
        throw new Error("Only card payments can be refunded here");
      }
      // A just-cancelled order's own refund is sent right after the
      // cancellation commits. An admin refund in that moment would take its
      // place (review of #107), so wait until it has been attempted.
      if (orderRow.status === "cancelled" && orderRow.changed_recently) {
        const attempted = await client.query(
          `SELECT 1 FROM payment_refunds WHERE order_id = $1 LIMIT 1`,
          [orderId],
        );
        if (!attempted.rows.length) {
          throw new Error("This order's cancellation refund is still being sent automatically. Try again in a few minutes.");
        }
      }

      const p = await client.query(
        `SELECT id, provider, provider_transaction_id, amount
         FROM payments
         WHERE order_id = $1
           AND status = 'paid'
           AND provider_transaction_id IS NOT NULL
         ORDER BY created_at DESC
         LIMIT 1`,
        [orderId],
      );
      if (!p.rows.length) throw new Error("No card payment found for this order");
      payment = p.rows[0];

      const busy = await client.query(
        `SELECT id FROM payment_refunds WHERE payment_id = $1 AND status = 'processing' LIMIT 1`,
        [payment.id],
      );
      if (busy.rows.length) {
        throw new Error("A refund for this order is still being processed. Wait for Paystack to confirm it, then try again.");
      }

      const done = await client.query(
        `SELECT COALESCE(SUM(amount), 0) AS refunded
         FROM payment_refunds WHERE payment_id = $1 AND status = 'completed'`,
        [payment.id],
      );
      const paidCents = Math.round(parseFloat(payment.amount) * 100);
      const refundedCents = Math.round(parseFloat(done.rows[0].refunded) * 100);
      const leftCents = paidCents - refundedCents;
      if (leftCents <= 0) throw new Error("This order has already been refunded in full");

      const cents = requestedCents === null ? leftCents : requestedCents;
      if (cents > leftCents) {
        throw new Error(
          `The refund can't be more than R${(leftCents / 100).toFixed(2)} `
          + `(what's left of the R${(paidCents / 100).toFixed(2)} paid)`,
        );
      }
      isFull = cents === leftCents;

      const created = await client.query(
        `INSERT INTO payment_refunds (order_id, user_id, payment_id, amount, provider, status, reason)
         VALUES ($1, $2, $3, $4, $5, 'processing', $6)
         RETURNING *`,
        [orderId, orderRow.user_id, payment.id, cents / 100, payment.provider,
          `${isFull ? "admin_full" : "admin_partial"}:${typedReason}`],
      );
      refundRow = created.rows[0];
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    const { refundReference } = await RefundService.submitToPaystack(refundRow, {
      transactionId: payment.provider_transaction_id,
      amountInCents: Math.round(parseFloat(refundRow.amount) * 100),
      note: refundRow.reason,
      alert: { orderId, amount: refundRow.amount },
    });
    if (isFull) await RefundService.markOrderRefundPending(orderId, refundRow.id);
    console.log(
      `[Refund] Admin ${adminId} refund of R${parseFloat(refundRow.amount).toFixed(2)} `
      + `(${isFull ? "full" : "partial"}) submitted for order ${orderId}`,
    );
    return RefundService.readAttempt(refundRow, refundReference);
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
        `SELECT pr.id, pr.order_id, pr.status, pr.amount, pr.payment_id, pr.reason, p.status AS payment_status
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
      // PR G1 (#106): a partial admin refund leaves money with the order, so
      // the order stays paid; only its payment_refunds row is finalized.
      const partialAdminRefund = String(row.rows[0].reason || "").startsWith("admin_partial:");

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
      } else if (!partialAdminRefund) {
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
RefundService.userReason = userReason;
RefundService.STRAY = STRAY;
RefundService.STRAY_REFUNDED = STRAY_REFUNDED;

module.exports = RefundService;
