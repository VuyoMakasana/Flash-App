'use strict';

/**
 * orderChargeService.js — Step 1 (#102)
 *
 * Founder rule: a successful Paystack charge for an order is ALWAYS either
 * recorded against the order or refunded automatically. Never a charge with
 * nothing recorded.
 *
 * Before this, charge.success only marked an order paid when the charge's
 * reference was the one currently stored on the order. Paying an older
 * Paystack page (the app issues a new reference after 2 minutes) matched
 * nothing: the webhook rolled back, logged nothing and answered 200, so the
 * customer was charged and Flash had no record (audit P0-3).
 *
 * Every charge now ends in exactly one outcome:
 *   paid       the order was unpaid and alive, the reference is one of this
 *              order's references (any of them, old or new), and Paystack
 *              collected exactly the order total in ZAR: the order is marked
 *              paid and a payments row is written.
 *   stray      anything else that took money: a late payment on a cancelled
 *              order, a second payment for an order that's already paid, a
 *              wrong amount, or a reference that isn't this order's. The
 *              charge is recorded (payments.status = 'stray'), refunded in
 *              full automatically, and admins are alerted.
 *   duplicate  this exact Paystack transaction (or webhook event) was
 *              already handled: nothing changes.
 *
 * Shared by the charge.success webhook and the reconciliation job (a missed
 * webhook), so both paths always agree.
 */

const pool = require('../config/database');
const paystackService = require('./paystackService');
const RefundService = require('./refundService');
const { sendPaymentAlertEmail } = require('./emailService');

const STRAY_REASONS = {
  CANCELLED_ORDER: 'late_charge_cancelled_order',
  ALREADY_PAID: 'duplicate_charge',
  AMOUNT_MISMATCH: 'amount_mismatch',
  WRONG_REFERENCE: 'reference_not_for_this_order',
};

const STRAY_TITLES = {
  [STRAY_REASONS.CANCELLED_ORDER]: 'A cancelled order was paid; the payment is being refunded',
  [STRAY_REASONS.ALREADY_PAID]: 'An order was paid twice; the extra payment is being refunded',
  [STRAY_REASONS.AMOUNT_MISMATCH]: 'A payment did not match the order total; it is being refunded',
  [STRAY_REASONS.WRONG_REFERENCE]: 'A payment did not belong to its order; it is being refunded',
};

const UNPAID_ORDER_STATES = ['created', 'payment_pending'];
const UNPAID_PAYMENT_STATES = ['pending', 'failed'];

// Every reference Flash creates for an order payment: hosted checkout
// (paystackService.initializePayment) and saved card
// (paymentController.chargeSavedCard).
function referenceBelongsToOrder(reference, orderId) {
  const ref = String(reference || '');
  return ref.startsWith(`flash_${orderId}_`) || ref.startsWith(`flash_sc_${orderId}_`);
}

function classify(order, charge) {
  if (order.status === 'cancelled') return STRAY_REASONS.CANCELLED_ORDER;
  if (!referenceBelongsToOrder(charge.reference, order.id)) return STRAY_REASONS.WRONG_REFERENCE;
  const unpaid = UNPAID_ORDER_STATES.includes(order.status)
    && (order.payment_status == null || UNPAID_PAYMENT_STATES.includes(order.payment_status));
  if (!unpaid) return STRAY_REASONS.ALREADY_PAID;
  if (!paystackService.amountMatchesOrder(charge, order.total)) return STRAY_REASONS.AMOUNT_MISMATCH;
  return null;
}

/**
 * @param {object} charge  { orderId, reference, transactionId, amount (cents), currency }
 * @param {object} context { eventId, eventType, source ('webhook' | 'reconciliation') }
 * @returns {Promise<{ outcome: 'paid'|'stray'|'duplicate'|'unknown_order', userId?, reason?, paymentId? }>}
 */
async function applyOrderCharge(charge, context = {}) {
  const { eventId = null, eventType = 'charge.success', source = 'webhook' } = context;
  const { orderId, reference } = charge;
  const transactionId = charge.transactionId != null ? String(charge.transactionId) : null;
  const amountRand = Number.isFinite(Number(charge.amount)) ? Number(charge.amount) / 100 : null;

  const client = await pool.connect();
  let result;
  try {
    await client.query('BEGIN');

    // Webhook idempotency marker, inside this transaction: a rollback also
    // removes it, so a Paystack retry can safely redo the work.
    if (eventId) {
      try {
        await client.query(
          'INSERT INTO webhook_events (paystack_event_id, event_type) VALUES ($1, $2)',
          [String(eventId), eventType],
        );
      } catch (dupErr) {
        if (dupErr.code === '23505') {
          await client.query('ROLLBACK');
          return { outcome: 'duplicate' };
        }
        throw dupErr;
      }
    }

    // This exact transaction was already recorded (paid or stray), e.g. the
    // webhook and the reconciliation job both saw it.
    if (transactionId) {
      const seen = await client.query(
        'SELECT 1 FROM payments WHERE provider_transaction_id = $1',
        [transactionId],
      );
      if (seen.rows.length) {
        await client.query('COMMIT');
        return { outcome: 'duplicate' };
      }
    }

    const orderResult = await client.query(
      `SELECT id, user_id, status, payment_status, total, paystack_reference
       FROM orders WHERE id = $1 FOR UPDATE`,
      [orderId],
    );

    if (!orderResult.rows.length) {
      // Practically impossible (orderId comes from Flash's own metadata and
      // orders are never deleted), but money arrived: record it with no
      // order, and alert. It can't be refunded automatically without an
      // order (payment_refunds needs one), so an admin refunds it in Paystack.
      await client.query(
        `INSERT INTO payments
           (order_id, user_id, amount, method, provider, provider_transaction_id, status, type, metadata)
         VALUES (NULL, NULL, $1, 'card', 'paystack', $2, $3, 'store', $4::jsonb)
         ON CONFLICT (provider_transaction_id) DO NOTHING`,
        [amountRand, transactionId, RefundService.STRAY,
          JSON.stringify({ strayReason: 'unknown_order', orderId, reference, source })],
      );
      await client.query('COMMIT');
      result = { outcome: 'unknown_order' };
    } else {
      const order = orderResult.rows[0];
      const strayReason = classify(order, charge);

      if (!strayReason) {
        await client.query(
          `UPDATE orders
           SET payment_status = 'paid', payment_method = 'card', paystack_reference = $2,
               delivery_payment_status = 'pending_driver', store_paid = true, updated_at = NOW()
           WHERE id = $1`,
          [order.id, reference],
        );
        await client.query(
          `INSERT INTO payments
             (order_id, user_id, amount, method, provider, provider_transaction_id, status, type)
           VALUES ($1, $2, $3, 'card', 'paystack', $4, 'paid', 'store')
           ON CONFLICT (provider_transaction_id) DO NOTHING`,
          [order.id, order.user_id, amountRand, transactionId],
        );
        await client.query('COMMIT');
        const olderPage = order.paystack_reference && order.paystack_reference !== reference;
        console.log(
          `[Charge] Payment transition pending->paid orderId=${order.id} reference=${reference} source=${source}`
          + (olderPage ? ' (an older payment page was paid; recorded against the order)' : ''),
        );
        return { outcome: 'paid', userId: order.user_id };
      }

      const inserted = await client.query(
        `INSERT INTO payments
           (order_id, user_id, amount, method, provider, provider_transaction_id, status, type, metadata)
         VALUES ($1, $2, $3, 'card', 'paystack', $4, $5, 'store', $6::jsonb)
         ON CONFLICT (provider_transaction_id) DO NOTHING
         RETURNING id`,
        [order.id, order.user_id, amountRand, transactionId, RefundService.STRAY,
          JSON.stringify({
            strayReason, reference, source,
            orderStatus: order.status, orderPaymentStatus: order.payment_status, orderTotal: order.total,
            currency: charge.currency || null,
          })],
      );
      await client.query('COMMIT');
      result = { outcome: 'stray', reason: strayReason, paymentId: inserted.rows[0]?.id || null, userId: order.user_id };
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // After the commit: refund and alert. The charge is already recorded, so
  // a failure here is retried by the reconciliation job (up to the cap).
  if (result.outcome === 'unknown_order') {
    console.error(
      `[Charge] CRITICAL: Paystack charge for unknown order ${orderId}, reference=${reference}, `
      + `transaction=${transactionId}. Recorded with no order; refund it in the Paystack dashboard.`,
    );
    await sendPaymentAlertEmail({
      title: 'A payment arrived for an order that does not exist',
      orderId,
      amount: amountRand,
      details: [`Paystack reference: ${reference}`, 'Refund it manually in the Paystack dashboard.'],
    }).catch((e) => console.error('[Charge] alert email failed:', e.message));
    return result;
  }

  console.error(
    `[Charge] CRITICAL: stray charge (${result.reason}) on order ${orderId}: reference=${reference}, `
    + `amount=${charge.amount} ${charge.currency || 'no-currency'}, source=${source}. `
    + 'Recorded and being refunded in full automatically. The order was NOT changed.',
  );
  let refundNote = 'The automatic refund has been started.';
  if (result.paymentId) {
    try {
      await RefundService.refundStrayPayment(result.paymentId);
    } catch (refundErr) {
      refundNote = `The automatic refund failed (${refundErr.message}); it is retried automatically, up to `
        + `${RefundService.MAX_AUTOMATIC_REFUND_ATTEMPTS} attempts.`;
      console.error(`[Charge] stray refund failed for payment ${result.paymentId}:`, refundErr.message);
    }
  }
  await sendPaymentAlertEmail({
    title: STRAY_TITLES[result.reason],
    orderId,
    amount: amountRand,
    details: [`Paystack reference: ${reference}`, refundNote],
  }).catch((e) => console.error('[Charge] alert email failed:', e.message));
  return result;
}

module.exports = { applyOrderCharge, referenceBelongsToOrder, STRAY_REASONS };
