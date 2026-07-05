'use strict';

/**
 * webhookController.js
 *
 * CRITICAL-3 FIX: handlePayflex() method removed.
 *   The /webhooks/payflex route is also removed from webhookRoutes.js.
 *   The payflex_webhook_events table is kept in the DB for historical records
 *   but no new rows are written here.
 */

const crypto  = require('crypto');
const pool    = require('../config/database');
const { getOptional, isProd } = require('../config/env');
const Payment = require('../models/Payment');
const Subscription = require('../models/Subscription');
const RefundService = require('../services/refundService');
const { autoAssignNearestDriver } = require('../services/autoMatchService');
const { updateOrderStatus }       = require('../services/orderStateMachineService');
const { notifyDriversNewOrder }   = require('../services/notificationService');
const PayoutService               = require('../services/payoutService');
const { isClosedNow, getNextOpenTime } = require('../services/operatingHoursService');

class WebhookController {

  static async handlePaystack(req, res) {
    try {
      const secretKey = getOptional('PAYSTACK_SECRET_KEY', 'webhook');

      if (!secretKey && isProd) {
        console.error('[Webhook] CRITICAL: Cannot verify Paystack webhooks without PAYSTACK_SECRET_KEY');
        return res.status(500).send('Webhook secret not configured');
      }

      if (!Buffer.isBuffer(req.body)) {
        console.warn('[Webhook] Paystack request body was not raw bytes');
        return res.status(400).send('Invalid webhook body');
      }

      if (secretKey) {
        const hash = crypto
          .createHmac('sha512', secretKey)
          .update(req.body)
          .digest('hex');

        const signatureHeaderRaw = req.headers['x-paystack-signature'];
        const signatureHeader    = signatureHeaderRaw == null ? '' : String(signatureHeaderRaw);

        if (!signatureHeader) {
          console.warn('[Webhook] Paystack signature missing — rejecting request');
          return res.status(400).send('Invalid signature');
        }

        let receivedBuf;
        try {
          receivedBuf = Buffer.from(signatureHeader, 'hex');
        } catch (e) {
          console.warn('[Webhook] Paystack signature not valid hex — rejecting request');
          return res.status(400).send('Invalid signature');
        }

        const computedBuf = Buffer.from(hash, 'hex');
        if (computedBuf.length !== receivedBuf.length ||
            !crypto.timingSafeEqual(computedBuf, receivedBuf)) {
          console.warn('[Webhook] Paystack signature mismatch — rejecting request');
          return res.status(400).send('Invalid signature');
        }
      } else {
        console.warn('[Webhook] Skipping signature check — PAYSTACK_SECRET_KEY not configured');
      }

      let event;
      try {
        event = JSON.parse(req.body.toString('utf8'));
      } catch (e) {
        console.error('[Webhook] Failed to parse Paystack body:', e.message);
        return res.status(400).send('Invalid payload');
      }

      console.log(
        `[Webhook] Paystack received event=${event.event || 'unknown'} eventId=${event.id || 'n/a'} orderId=${event.data?.metadata?.orderId || 'n/a'} reference=${event.data?.reference || 'n/a'}`,
      );
      const io = req.app.get('io');

      if (event.event === 'charge.success') {
        await WebhookController.handleChargeSuccess(event, io);
      } else if (event.event === 'charge.failed' || event.event === 'charge.abandoned') {
        await WebhookController.handleChargeFailed(event, io);
      } else if (event.event === 'transfer.success') {
        await WebhookController.handleTransferSuccess(event);
      } else if (event.event === 'transfer.failed' || event.event === 'transfer.reversed') {
        await WebhookController.handleTransferFailed(event);
      } else if (event.event === 'refund.processed') {
        await WebhookController.handleRefundProcessed(event, io);
      } else if (event.event === 'refund.failed') {
        await WebhookController.handleRefundFailed(event, io);
      }

      return res.sendStatus(200);

    } catch (err) {
      console.error('[Webhook] Paystack processing error:', err.message);
      return res.status(500).send('Webhook processing failed');
    }
  }

  static async handleChargeSuccess(event, io) {
    const data     = event.data;
    const metaType = data?.metadata?.type;

    // Driver subscription / Flash Premium charges have no orders row to
    // attach to — handle and finalize them separately from order payments.
    if (metaType === 'driver_subscription' || metaType === 'premium_subscription') {
      return WebhookController.handleSubscriptionCharge(event);
    }

    const orderId = data?.metadata?.orderId;

    if (!orderId) return;

    if (data.authorization?.reusable && data.metadata?.userId) {
      const auth = data.authorization;
      await Payment.saveCard(data.metadata.userId, auth).catch(() => {});
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Idempotency: insert event ID within the transaction so a rollback also
      // removes the marker, allowing safe retries on processing failures.
      if (event.id) {
        try {
          await client.query(
            `INSERT INTO webhook_events (paystack_event_id, event_type) VALUES ($1, $2)`,
            [String(event.id), event.event || 'unknown'],
          );
        } catch (dupErr) {
          if (dupErr.code === '23505') {
            await client.query('ROLLBACK');
            console.log(`[Webhook] Duplicate event ${event.id} — already processed, skipping`);
            return;
          }
          throw dupErr;
        }
      }

      const orderCheck = await client.query(
        `SELECT id, payment_status FROM orders WHERE id = $1 FOR UPDATE`,
        [orderId],
      );

      if (!orderCheck.rows.length) {
        await client.query('ROLLBACK');
        return;
      }

      if (orderCheck.rows[0].payment_status === 'paid') {
        await client.query('ROLLBACK');
        return;
      }

      const result = await client.query(
        `UPDATE orders
         SET payment_status = 'paid', payment_method = 'card',
             delivery_payment_status = 'pending_driver', store_paid = true, updated_at = NOW()
         WHERE id = $1 AND paystack_reference = $2
         RETURNING user_id`,
        [orderId, data.reference],
      );

      if (!result.rows.length) {
        await client.query('ROLLBACK');
        return;
      }

      const userId = result.rows[0].user_id;

      console.log(
        `[Webhook] Payment transition pending->paid orderId=${orderId} reference=${data.reference}`,
      );

      await client.query(
        `INSERT INTO payments
           (order_id, user_id, amount, method, provider, provider_transaction_id, status, type)
         VALUES ($1, $2, $3, 'card', 'paystack', $4, 'paid', 'store')
         ON CONFLICT (provider_transaction_id) DO NOTHING`,
        [orderId, userId, data.amount / 100, String(data.id)],
      );

      await client.query('COMMIT');

      try {
        await updateOrderStatus(orderId, 'paid', {
          actorId:   String(event.id || 'paystack'),
          actorRole: 'webhook',
          io,
        });
      } catch (transitionErr) {
        console.warn('[Webhook] paid transition skipped:', transitionErr.message);
      }

      if (isClosedNow()) {
        const openAt = getNextOpenTime();
        await pool.query(
          `UPDATE orders SET scheduled_for = $1, updated_at = NOW() WHERE id = $2`,
          [openAt, orderId],
        );
        try {
          await updateOrderStatus(orderId, 'scheduled_for_morning', {
            actorId:   String(event.id || 'paystack'),
            actorRole: 'webhook',
            io,
          });
        } catch (e) {
          console.warn('[Webhook] scheduled_for_morning transition skipped:', e.message);
        }
        if (io) {
          io.to(`user:${userId}`).emit('payment_confirmed', { orderId, scheduled: true, openAt });
          io.to(`user:${userId}`).emit('order_scheduled', {
            orderId,
            openAt:  openAt.toISOString(),
            message: `Flash opens at 07:00. Your order will be assigned to a driver then.`,
          });
        }
        console.log(`[Webhook] Card order ${orderId} scheduled for morning — outside operating hours`);
      } else {
        try {
          await updateOrderStatus(orderId, 'waiting_for_driver', {
            actorId:   String(event.id || 'paystack'),
            actorRole: 'webhook',
            io,
          });
        } catch (transitionErr) {
          console.warn('[Webhook] waiting_for_driver transition skipped:', transitionErr.message);
        }

        const prefRow = await pool.query(
          `SELECT preferred_driver_id, preferred_driver_expires_at FROM orders WHERE id = $1`,
          [orderId],
        );
        const pref = prefRow.rows[0] || {};
        const hasUnexpiredPreference =
          pref.preferred_driver_id &&
          pref.preferred_driver_expires_at &&
          new Date(pref.preferred_driver_expires_at).getTime() > Date.now();

        if (io) {
          io.to(`user:${userId}`).emit('payment_confirmed', { orderId });
          if (hasUnexpiredPreference) {
            io.to(`driver:${pref.preferred_driver_id}`).emit('new_order_available', {
              orderId,
              isCashDelivery:      false,
              preferredAssignment: true,
            });
          } else {
            io.to('driver_pool').emit('new_order_available', { orderId, isCashDelivery: false });
          }
        }

        await autoAssignNearestDriver(orderId, io).catch(() => null);

        notifyDriversNewOrder(
          orderId,
          false,
          pref.preferred_driver_id || null,
          pref.preferred_driver_expires_at || null,
        ).catch(() => null);
      }

    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[Webhook] handleChargeSuccess error:', err.message);
      throw err;
    } finally {
      client.release();
    }
  }

  // Finalizes a driver_subscription or premium_subscription charge — the
  // counterpart to Subscription.purchaseDriverPlan()/purchasePremium(),
  // which only initialize the Paystack hosted-checkout redirect. Mirrors
  // handleChargeSuccess()'s idempotency pattern (event id inserted inside
  // the same transaction, so a rollback also removes the marker and allows
  // a safe retry) but there is no orders row to lock here.
  static async handleSubscriptionCharge(event) {
    const data = event.data;
    const { type, driverId, planId, userId } = data?.metadata || {};

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      if (event.id) {
        try {
          await client.query(
            `INSERT INTO webhook_events (paystack_event_id, event_type) VALUES ($1, $2)`,
            [String(event.id), event.event || 'unknown'],
          );
        } catch (dupErr) {
          if (dupErr.code === '23505') {
            await client.query('ROLLBACK');
            console.log(`[Webhook] Duplicate event ${event.id} — already processed, skipping`);
            return;
          }
          throw dupErr;
        }
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[Webhook] handleSubscriptionCharge idempotency error:', err.message);
      throw err;
    } finally {
      client.release();
    }

    try {
      if (type === 'driver_subscription' && driverId && planId) {
        await Subscription.activateDriverPlan(driverId, planId, data.reference);
        console.log(`[Webhook] Activated driver_subscription plan=${planId} driverId=${driverId} ref=${data.reference}`);
      } else if (type === 'premium_subscription' && userId) {
        await Subscription.activatePremium(userId, data.reference);
        console.log(`[Webhook] Activated premium_subscription userId=${userId} ref=${data.reference}`);
      } else {
        console.warn('[Webhook] handleSubscriptionCharge: missing/invalid metadata', data?.metadata);
      }
    } catch (err) {
      console.error('[Webhook] Subscription activation failed:', err.message);
    }
  }

  static async handleChargeFailed(event, io) {
    const orderId  = event.data?.metadata?.orderId;
    const eventRef = event.data?.reference || null;

    if (!orderId) return;

    console.log(
      `[Webhook] Payment transition pending->failed orderId=${orderId} reference=${eventRef || 'n/a'} event=${event.event || 'unknown'}`,
    );

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      if (event.id) {
        try {
          await client.query(
            `INSERT INTO webhook_events (paystack_event_id, event_type) VALUES ($1, $2)`,
            [String(event.id), event.event || 'unknown'],
          );
        } catch (dupErr) {
          if (dupErr.code === '23505') {
            await client.query('ROLLBACK');
            console.log(`[Webhook] Duplicate event ${event.id} — already processed, skipping`);
            return;
          }
          throw dupErr;
        }
      }

      if (!eventRef) {
        console.warn(`[Webhook] handleChargeFailed: no reference in event for orderId=${orderId}, skipping`);
        await client.query('COMMIT');
        return;
      }

      const orderResult = await client.query(
        `SELECT paystack_reference, payment_status FROM orders WHERE id = $1 FOR UPDATE`,
        [orderId],
      );

      if (!orderResult.rows.length) {
        console.warn(`[Webhook] handleChargeFailed: order not found id=${orderId}, skipping`);
        await client.query('COMMIT');
        return;
      }

      const { paystack_reference: dbRef, payment_status: currentStatus } = orderResult.rows[0];

      if (dbRef && dbRef !== eventRef) {
        console.log(
          `[Webhook] handleChargeFailed: reference mismatch orderId=${orderId} dbRef=${dbRef} eventRef=${eventRef} — stale failure, not updating`,
        );
        await client.query('COMMIT');
        return;
      }

      if (currentStatus !== 'paid') {
        await client.query(
          `UPDATE orders
           SET payment_status = 'failed', updated_at = NOW()
           WHERE id = $1 AND payment_status <> 'paid' AND paystack_reference = $2`,
          [orderId, eventRef],
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[Webhook] handleChargeFailed error:', err.message);
      throw err;
    } finally {
      client.release();
    }

    const orderRow = await pool.query('SELECT user_id FROM orders WHERE id = $1', [orderId]);
    if (io && orderRow.rows.length) {
      io.to(`user:${orderRow.rows[0].user_id}`).emit('payment_failed', {
        orderId,
        message: 'Your payment failed. Please try again.',
      });
    }
  }

  static async handleTransferSuccess(event) {
    const data      = event.data || {};
    const reference = data.reference;
    if (!reference) return;

    const txRow = await pool.query(
      `SELECT pt.id, pt.driver_id, pt.amount, pt.payout_request_id
       FROM payout_transactions pt
       WHERE pt.reference = $1`,
      [reference],
    );
    if (!txRow.rows.length) return;

    const { id: txId, driver_id, amount, payout_request_id } = txRow.rows[0];
    await PayoutService.finalizeSuccessfulPayout(driver_id, amount, payout_request_id, txId);
    console.log(`[Webhook] Transfer success finalized driverId=${driver_id} ref=${reference}`);
  }

  static async handleTransferFailed(event) {
    const reference = event.data?.reference;
    if (!reference) return;
    await PayoutService.handleFailedPayout(reference);
    console.log(`[Webhook] Transfer failed/reversed ref=${reference}`);
  }

  // Paystack's `data.transaction` field has been observed in two different
  // shapes across their own endpoints (confirmed live, test mode): an object
  // with an `id` on the refund-creation response, but a bare number on the
  // fetch-by-id response. Since an actual inbound webhook can't be captured
  // in this environment (no public URL to receive one), this normalizes both
  // possible shapes rather than assuming either.
  static extractRefundIds(data) {
    const refundId = data?.id != null ? String(data.id) : null;
    let transactionId = null;
    if (data?.transaction != null) {
      transactionId = typeof data.transaction === 'object'
        ? (data.transaction.id != null ? String(data.transaction.id) : null)
        : String(data.transaction);
    }
    return { refundId, transactionId };
  }

  static async handleRefundProcessed(event, io) {
    const { refundId, transactionId } = WebhookController.extractRefundIds(event.data);
    if (!refundId && !transactionId) return;

    const result = await RefundService.finalizeRefund(refundId, transactionId, 'completed', event, event);
    if (!result || result.alreadyFinalized) return;

    console.log(`[Webhook] Refund confirmed processed orderId=${result.orderId} refundId=${refundId}`);

    if (io) {
      const orderRow = await pool.query('SELECT user_id FROM orders WHERE id = $1', [result.orderId]);
      if (orderRow.rows.length) {
        io.to(`user:${orderRow.rows[0].user_id}`).emit('order_update', {
          orderId: result.orderId,
          refundStatus: 'completed',
          message: 'Your refund has been processed.',
        });
      }
      io.to(`order:${result.orderId}`).emit('order_update', { orderId: result.orderId, refundStatus: 'completed' });
    }
  }

  static async handleRefundFailed(event, io) {
    const { refundId, transactionId } = WebhookController.extractRefundIds(event.data);
    if (!refundId && !transactionId) return;

    const result = await RefundService.finalizeRefund(refundId, transactionId, 'failed', event, event);
    if (!result || result.alreadyFinalized) return;

    // A failed refund on a cancelled order means the customer's money did
    // not actually come back — this needs a human, not a silent retry, so
    // it's logged loudly and pushed to the admin room rather than just the
    // customer.
    console.error(`[Webhook] REFUND FAILED orderId=${result.orderId} refundId=${refundId} — needs manual attention`);

    if (io) {
      io.to('admin').emit('fleet_alert', {
        type: 'refund_failed',
        orderId: result.orderId,
        message: 'A customer refund failed on Paystack\'s side and needs manual review.',
      });
    }
  }
}

module.exports = WebhookController;
