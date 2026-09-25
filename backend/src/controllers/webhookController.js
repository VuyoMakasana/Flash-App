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
const Order = require('../models/Order');
const Subscription = require('../models/Subscription');
const Boost = require('../models/Boost');
const RefundService = require('../services/refundService');
const { updateOrderStatus, notifyAdminNewOrderPendingAcceptance } = require('../services/orderStateMachineService');
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

    // Store boost charges (final admin-panel completion pass, §4) — same
    // "no orders row" shape as subscriptions above.
    if (metaType === 'store_boost') {
      return WebhookController.handleBoostCharge(event);
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
        // No longer transitions straight to waiting_for_driver / notifies
        // drivers here -- a paid order now waits for a real store
        // accept/reject (docs/audits/FLASH_STORE_ADMIN_DESIGN.md §0) before
        // driver matching begins. That handoff now lives in
        // orderStateMachineService.markReadyForPickup(), triggered by the
        // store's own "Mark Ready for Pickup" admin action, not
        // automatically the moment payment clears.
        try {
          const updated = await updateOrderStatus(orderId, 'pending_store_acceptance', {
            actorId:   String(event.id || 'paystack'),
            actorRole: 'webhook',
            io,
          });
          // §2.12 audit — a new order reaching pending_store_acceptance
          // previously had zero admin-facing signal (see
          // orderStateMachineService.js's own §2.12 comment for the full
          // reasoning). Best-effort, never blocks the payment-confirmed
          // response to the customer.
          notifyAdminNewOrderPendingAcceptance(updated, io);
        } catch (transitionErr) {
          console.warn('[Webhook] pending_store_acceptance transition skipped:', transitionErr.message);
        }

        if (io) {
          io.to(`user:${userId}`).emit('payment_confirmed', { orderId });
        }
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

  // Finalizes a store_boost charge — the counterpart to Boost.purchaseBoost(),
  // which only initializes the Paystack hosted-checkout redirect. Mirrors
  // handleSubscriptionCharge()'s idempotency pattern exactly (event id
  // inserted inside its own transaction, so a rollback also removes the
  // marker and allows a safe retry) — there is no orders row to lock here.
  static async handleBoostCharge(event) {
    const data = event.data;
    const { productId, boostType } = data?.metadata || {};

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
      console.error('[Webhook] handleBoostCharge idempotency error:', err.message);
      throw err;
    } finally {
      client.release();
    }

    try {
      if (productId && boostType) {
        await Boost.activateBoost(productId, boostType, data.reference);
        console.log(`[Webhook] Activated store_boost type=${boostType} productId=${productId} ref=${data.reference}`);
      } else {
        console.warn('[Webhook] handleBoostCharge: missing/invalid metadata', data?.metadata);
      }
    } catch (err) {
      console.error('[Webhook] Boost activation failed:', err.message);
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
        // F-04 remediation — the WHERE clause now also excludes an
        // already-'failed' order so a second failure event for the same
        // order (a genuinely different Paystack event id — e.g.
        // charge.failed followed by charge.abandoned — passes the
        // webhook_events idempotency check above on its own) can't match
        // this UPDATE a second time. RETURNING id is the real transition
        // signal: a duplicate/stale event affects zero rows and restocks
        // nothing, exactly the same idempotency shape already proven
        // correct for handleChargeSuccess's payment_status='paid' guard.
        const failResult = await client.query(
          `UPDATE orders
           SET payment_status = 'failed', updated_at = NOW()
           WHERE id = $1 AND payment_status <> 'paid' AND payment_status <> 'failed' AND paystack_reference = $2
           RETURNING id`,
          [orderId, eventRef],
        );

        // This order never became 'paid' and its status never transitions
        // to 'cancelled' here (nobody cancelled it — the charge simply
        // didn't go through), so orderStateMachineService.updateOrderStatus's
        // own restock hook (F-04) never fires for this path. The stock
        // this order reserved at create() time must still be released here,
        // directly, inside this same transaction.
        if (failResult.rows.length) {
          await Order.restockItems(orderId, client);
        }
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

  // ─── RESEND: EMAIL DELIVERY EVENTS ───────────────────────────────────────
  //
  // Flash could not see a bounce before this existed. sendEmail() resolves the
  // moment Resend ACCEPTS a message; the bounce happens asynchronously
  // afterwards, so every caller logged success and moved on. A real store
  // password-reset to a real Gmail address bounced on 24 Sep 2026 and nothing
  // recorded it — it was found only by going and looking in Resend.
  //
  // That is worst for onboarding: the welcome email is the ONLY way an approved
  // owner ever gets a password, so a bounce leaves an active store whose owner
  // cannot sign in, while the store, the account and the token all look healthy.
  //
  // Verification follows Svix's scheme (Resend delegates webhook signing to
  // Svix), implemented with node's crypto rather than by adding the `svix`
  // package — one more dependency in the webhook path is not worth saving
  // twenty lines, and this file already verifies Paystack's HMAC by hand.
  static async handleResend(req, res) {
    const signingSecret = getOptional('RESEND_WEBHOOK_SECRET', 'webhook');

    if (!signingSecret) {
      // Refuse rather than accept unverified events. An endpoint that writes to
      // the database on the word of any anonymous caller is worse than one that
      // is temporarily down: Svix retries, so a missing secret costs nothing
      // permanent, whereas an unauthenticated write path would let anyone forge
      // "bounced" against any address.
      console.error('[Webhook] Resend: RESEND_WEBHOOK_SECRET not configured — rejecting event');
      return res.status(500).send('Webhook secret not configured');
    }

    if (!Buffer.isBuffer(req.body)) {
      console.warn('[Webhook] Resend request body was not raw bytes');
      return res.status(400).send('Invalid webhook body');
    }

    const svixId        = String(req.headers['svix-id'] || '');
    const svixTimestamp = String(req.headers['svix-timestamp'] || '');
    const svixSignature = String(req.headers['svix-signature'] || '');

    if (!svixId || !svixTimestamp || !svixSignature) {
      console.warn('[Webhook] Resend: missing svix headers — rejecting');
      return res.status(400).send('Invalid signature');
    }

    // Replay window. Without it a captured request stays valid forever and
    // could be replayed indefinitely. 300s is Svix's own default tolerance.
    const timestampSeconds = Number(svixTimestamp);
    if (!Number.isFinite(timestampSeconds)
        || Math.abs(Date.now() / 1000 - timestampSeconds) > 300) {
      console.warn('[Webhook] Resend: timestamp outside tolerance — rejecting');
      return res.status(400).send('Invalid signature');
    }

    // Secret is whsec_<base64>; the base64 portion decodes to the HMAC key.
    const secretBytes = Buffer.from(signingSecret.replace(/^whsec_/, ''), 'base64');
    const signedContent = svixId + '.' + svixTimestamp + '.' + req.body.toString('utf8');
    const expected = crypto.createHmac('sha256', secretBytes).update(signedContent).digest('base64');
    const expectedBuf = Buffer.from(expected, 'base64');

    // The header carries space-delimited "v1,<sig>" entries, and may hold more
    // than one during a secret rotation, so any single valid v1 entry passes.
    const matched = svixSignature.split(' ').some((entry) => {
      const [version, value] = entry.split(',');
      if (version !== 'v1' || !value) return false;
      let candidate;
      try {
        candidate = Buffer.from(value, 'base64');
      } catch (e) {
        return false;
      }
      // Length checked first: timingSafeEqual throws on a length mismatch.
      return candidate.length === expectedBuf.length
        && crypto.timingSafeEqual(candidate, expectedBuf);
    });

    if (!matched) {
      console.warn('[Webhook] Resend: signature mismatch — rejecting request');
      return res.status(400).send('Invalid signature');
    }

    let event;
    try {
      event = JSON.parse(req.body.toString('utf8'));
    } catch (e) {
      console.error('[Webhook] Resend: failed to parse body:', e.message);
      return res.status(400).send('Invalid payload');
    }

    try {
      await WebhookController.recordResendEvent(svixId, event);
    } catch (err) {
      // 500 so Svix retries. Losing a bounce silently is the exact failure this
      // feature exists to remove, so a write failure must not hide behind a 200.
      console.error('[Webhook] Resend: failed to record event:', err.message);
      return res.status(500).send('Failed to record event');
    }

    return res.status(200).send('ok');
  }

  // Split out from the request handler so it is unit-testable without having to
  // construct a validly-signed request.
  static async recordResendEvent(svixId, event) {
    const { TRACKED_EMAIL_KINDS } = require('../services/emailService');

    const eventType = (event && event.type) || 'unknown';
    const data      = (event && event.data) || {};
    // `to` is an array on Resend's payloads.
    const recipient = Array.isArray(data.to) ? data.to[0] : (data.to || null);
    const subject   = data.subject || null;
    const reason    = data.reason || (data.bounce && (data.bounce.message || data.bounce.subType)) || null;

    // ON CONFLICT against the UNIQUE svix_id is what makes this idempotent:
    // Svix retries on any non-2xx and on timeouts, so the same event
    // legitimately arrives more than once and must not be recorded twice or
    // double-update the account below.
    const inserted = await pool.query(
      `INSERT INTO email_events (svix_id, resend_email_id, event_type, recipient, subject, reason, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (svix_id) DO NOTHING
       RETURNING id`,
      [svixId, data.email_id || null, eventType, recipient, subject, reason, JSON.stringify(event)],
    );

    if (!inserted.rows.length) {
      console.log(`[Webhook] Resend: duplicate event ${svixId} ignored`);
      return { duplicate: true };
    }

    console.log(`[Webhook] Resend: ${eventType} for ${recipient || 'unknown recipient'}${reason ? ' — ' + reason : ''}`);

    // Only failures are mirrored onto the account. A delivered event is kept in
    // email_events for context but must never overwrite a bounce: the
    // operationally interesting state is "this person did not get it", and a
    // later unrelated delivery should not erase that.
    const isFailure = eventType === 'email.bounced' || eventType === 'email.delivery_delayed';
    if (!isFailure || !recipient || !subject) return { duplicate: false };

    const tracked = TRACKED_EMAIL_KINDS[subject];
    if (!tracked) return { duplicate: false };

    // Column names come from TRACKED_EMAIL_KINDS, never from the payload, so
    // there is no injection surface despite the interpolation.
    const status = eventType === 'email.bounced' ? 'bounced' : 'delayed';
    const updated = await pool.query(
      `UPDATE store_users
          SET ${tracked.statusColumn} = $2, ${tracked.timestampColumn} = NOW(), updated_at = NOW()
        WHERE email = $1
        RETURNING id`,
      [recipient, status],
    );

    if (updated.rows.length) {
      console.warn(
        `[Webhook] Resend: ${tracked.kind} email ${status} for store user ${updated.rows[0].id} (${recipient}) — this account may be unable to sign in`,
      );
    }
    return { duplicate: false, storeUsersUpdated: updated.rows.length };
  }
}

module.exports = WebhookController;
