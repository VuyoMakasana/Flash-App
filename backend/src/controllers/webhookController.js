const crypto = require('crypto');
const pool   = require('../config/database');
const { getOptional, isProd } = require('../config/env');
const Payment = require('../models/Payment');
const { autoAssignNearestDriver } = require('../services/fleetIntelligenceService');
const { updateOrderStatus } = require('../services/orderStateMachineService');
const { notifyDriversNewOrder } = require('../services/notificationService');
const PayoutService = require('../services/payoutService');
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
        const signatureHeader = signatureHeaderRaw == null ? '' : String(signatureHeaderRaw);

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
      }

      return res.sendStatus(200);

    } catch (err) {
      console.error('[Webhook] Paystack processing error:', err.message);
      return res.status(500).send('Webhook processing failed');
    }
  }

  static async handleChargeSuccess(event, io) {
    const data    = event.data;
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
          actorId: String(event.id || 'paystack'),
          actorRole: 'webhook',
          io,
        });
      } catch (transitionErr) {
        console.warn('[Webhook] paid transition skipped:', transitionErr.message);
      }

      if (isClosedNow()) {
        // Outside operating hours — hold order until morning
        const openAt = getNextOpenTime();
        await pool.query(
          `UPDATE orders SET scheduled_for = $1, updated_at = NOW() WHERE id = $2`,
          [openAt, orderId]
        );
        try {
          await updateOrderStatus(orderId, 'scheduled_for_morning', {
            actorId: String(event.id || 'paystack'),
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
            openAt: openAt.toISOString(),
            message: `Flash opens at 07:00. Your order will be assigned to a driver then.`,
          });
        }
        console.log(`[Webhook] Card order ${orderId} scheduled for morning — outside operating hours`);
      } else {
        // Within operating hours — release immediately
        try {
          await updateOrderStatus(orderId, 'waiting_for_driver', {
            actorId: String(event.id || 'paystack'),
            actorRole: 'webhook',
            io,
          });
        } catch (transitionErr) {
          console.warn('[Webhook] waiting_for_driver transition skipped:', transitionErr.message);
        }

        // FIXED (trusted driver): look up preferred_driver_id /
        // preferred_driver_expires_at so the broadcast and push notification
        // can be scoped to just that driver while the exclusivity window is
        // open, instead of unconditionally alerting the entire driver_pool.
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
              isCashDelivery: false,
              preferredAssignment: true,
            });
          } else {
            io.to('driver_pool').emit('new_order_available', { orderId, isCashDelivery: false });
          }
        }

        await autoAssignNearestDriver(orderId, io).catch(() => null);

        // Push notification to online drivers — fire and forget, non-blocking.
        // Scoped to the preferred driver while the exclusivity window is open.
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

      // Idempotency: insert event ID within the transaction so retries are
      // safe if processing rolls back before completing.
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

      // Lock the row and validate that the failure reference matches the
      // current order reference before applying the failed transition.
      // This prevents a stale failure webhook from an older attempt from
      // overwriting the state of a newer charge attempt.
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

      // Only mark failed when not already paid and the reference matches.
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

    // Called by the Paystack transfer.success webhook.
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

    // Called by the Paystack transfer.failed / transfer.reversed webhook.
    static async handleTransferFailed(event) {
      const reference = event.data?.reference;
      if (!reference) return;
      await PayoutService.handleFailedPayout(reference);
      console.log(`[Webhook] Transfer failed/reversed ref=${reference}`);
    }

  static async handlePayflex(req, res) {
    // FIX 8: Added event_id to Payflex webhook body — needed for idempotency to prevent duplicate driver assignments
    const { orderId, status, event_id } = req.body;
    const io = req.app.get('io');

    const payflexSecret = process.env.PAYFLEX_WEBHOOK_SECRET;
    if (payflexSecret) {
      const headerValue = req.headers['x-payflex-signature'];
      const incomingSecret = typeof headerValue === 'string'
        ? headerValue
        : Array.isArray(headerValue) ? headerValue[0] : '';

      const expectedBuf = Buffer.from(String(payflexSecret), 'utf8');
      const incomingBuf = Buffer.from(String(incomingSecret), 'utf8');

      if (incomingBuf.length !== expectedBuf.length ||
          !crypto.timingSafeEqual(incomingBuf, expectedBuf)) {
        console.warn('[Webhook] Payflex signature mismatch — ignoring request');
        return res.status(401).json({ error: 'Unauthorized' });
      }
    } else {
      if (isProd) {
        console.error('[Webhook] CRITICAL: PAYFLEX_WEBHOOK_SECRET is required in production');
        return res.status(500).json({ error: 'Webhook secret not configured' });
      }
      console.warn('[Webhook] PAYFLEX_WEBHOOK_SECRET not set — set before going live');
    }

    if (!orderId) {
      return res.status(400).json({ error: 'orderId is required' });
    }

    try {
      // Payflex idempotency — prevent double-processing the same event.
      const payflexEventId = req.headers['x-payflex-event-id']
        ? String(req.headers['x-payflex-event-id'])
        : `${orderId}_${String(status)}_${Date.now()}`;
      try {
        await pool.query(
          `INSERT INTO payflex_webhook_events (payflex_event_id, order_id, event_status)
           VALUES ($1, $2, $3)`,
          [payflexEventId, orderId, status],
        );
      } catch (dupErr) {
        if (dupErr.code === '23505') {
          console.log(`[Webhook] Duplicate Payflex event ${payflexEventId} — skipping`);
          return res.json({ received: true });
        }
        throw dupErr;
      }

      if (status === 'APPROVED') {
        // FIX 8: Payflex idempotency — Paystack webhook had this but Payflex did not, creating a risk of double driver assignment on duplicate callbacks
        if (event_id) {
          const idempClient = await pool.connect();
          try {
            await idempClient.query('BEGIN');
            await idempClient.query(
              `INSERT INTO webhook_events (paystack_event_id, event_type) VALUES ($1, $2)`,
              [String(event_id), `payflex_${status}`]
            );
            await idempClient.query('COMMIT');
          } catch (dupErr) {
            await idempClient.query('ROLLBACK');
            idempClient.release();
            if (dupErr.code === '23505') {
              return res.json({ received: true });
            }
            throw dupErr;
          }
          idempClient.release();
        }

        const client = await pool.connect();
        try {
          await client.query('BEGIN');

          const orderCheck = await client.query(
            `SELECT id, payment_status FROM orders WHERE id = $1 FOR UPDATE`,
            [orderId],
          );

          if (!orderCheck.rows.length) {
            await client.query('ROLLBACK');
            return res.json({ received: true });
          }

          if (orderCheck.rows[0].payment_status === 'paid') {
            await client.query('ROLLBACK');
            return res.json({ received: true });
          }

          const result = await client.query(
            `UPDATE orders
             SET payment_status = 'paid', payment_method = 'payflex',
                 delivery_payment_status = 'pending_driver', store_paid = true, updated_at = NOW()
             WHERE id = $1
             RETURNING user_id`,
            [orderId],
          );

          await client.query('COMMIT');

          try {
            await updateOrderStatus(orderId, 'paid', {
              actorId: String(req.headers['x-payflex-signature'] || 'payflex'),
              actorRole: 'webhook',
              io,
            });
          } catch (transitionErr) {
            console.warn('[Webhook] payflex paid transition skipped:', transitionErr.message);
          }

          try {
            await updateOrderStatus(orderId, 'waiting_for_driver', {
              actorId: String(req.headers['x-payflex-signature'] || 'payflex'),
              actorRole: 'webhook',
              io,
            });
          } catch (transitionErr) {
            console.warn('[Webhook] payflex waiting_for_driver transition skipped:', transitionErr.message);
          }

          // FIXED (trusted driver): same scoping as the Paystack webhook
          // above — only alert the preferred driver while their exclusivity
          // window is open, otherwise fall back to the full driver_pool.
          const payflexPrefRow = await client.query(
            `SELECT preferred_driver_id, preferred_driver_expires_at FROM orders WHERE id = $1`,
            [orderId],
          );
          const payflexPref = payflexPrefRow.rows[0] || {};
          const payflexHasUnexpiredPreference =
            payflexPref.preferred_driver_id &&
            payflexPref.preferred_driver_expires_at &&
            new Date(payflexPref.preferred_driver_expires_at).getTime() > Date.now();

          if (io && result.rows.length) {
            io.to(`user:${result.rows[0].user_id}`).emit('payment_confirmed', { orderId });
            if (payflexHasUnexpiredPreference) {
              io.to(`driver:${payflexPref.preferred_driver_id}`).emit('new_order_available', {
                orderId,
                isCashDelivery: false,
                preferredAssignment: true,
              });
            } else {
              io.to('driver_pool').emit('new_order_available', { orderId, isCashDelivery: false });
            }
          }
          await autoAssignNearestDriver(orderId, io).catch(() => null);
          // Push notification to online drivers — fire and forget, non-blocking.
          // Scoped to the preferred driver while the exclusivity window is open.
          notifyDriversNewOrder(
            orderId,
            false,
            payflexPref.preferred_driver_id || null,
            payflexPref.preferred_driver_expires_at || null,
          ).catch(() => null);
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        } finally {
          client.release();
        }

      } else if (status === 'DECLINED' || status === 'CANCELLED') {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');

          const orderCheck = await client.query(
            `SELECT id, payment_status FROM orders WHERE id = $1 FOR UPDATE`,
            [orderId],
          );

          // Only mark failed when not already paid to prevent out-of-order overwrites.
          if (orderCheck.rows.length && orderCheck.rows[0].payment_status !== 'paid') {
            await client.query(
              `UPDATE orders SET payment_status = 'failed', updated_at = NOW() WHERE id = $1`,
              [orderId],
            );
          }

          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        } finally {
          client.release();
        }
      }

      res.json({ received: true });
    } catch (err) {
      console.error('[Webhook] Payflex error:', err.message);
      res.status(500).json({ error: 'Webhook processing failed' });
    }
  }
}

module.exports = WebhookController;