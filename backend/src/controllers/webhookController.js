const crypto = require('crypto');
const pool   = require('../config/database');
const { getOptional, isProd } = require('../config/env');

class WebhookController {

  static async handlePaystack(req, res) {
    res.sendStatus(200);

    try {
      const secretKey = getOptional('PAYSTACK_SECRET_KEY', 'webhook');

      if (!secretKey && isProd) {
        console.error('[Webhook] CRITICAL: Cannot verify Paystack webhooks without PAYSTACK_SECRET_KEY');
        return;
      }

      if (secretKey) {
        const rawBody = Buffer.isBuffer(req.body)
          ? req.body
          : Buffer.from(JSON.stringify(req.body));

        const hash = crypto
          .createHmac('sha512', secretKey)
          .update(rawBody)
          .digest('hex');

        if (hash !== req.headers['x-paystack-signature']) {
          console.warn('[Webhook] Paystack signature mismatch — ignoring request');
          return;
        }
      } else {
        console.warn('[Webhook] Skipping signature check — PAYSTACK_SECRET_KEY not configured');
      }

      let event;
      try {
        const bodyStr = Buffer.isBuffer(req.body)
          ? req.body.toString('utf8')
          : JSON.stringify(req.body);
        event = JSON.parse(bodyStr);
      } catch (e) {
        console.error('[Webhook] Failed to parse Paystack body:', e.message);
        return;
      }

      console.log(
        `[Webhook] Paystack received event=${event.event || 'unknown'} eventId=${event.id || 'n/a'} orderId=${event.data?.metadata?.orderId || 'n/a'} reference=${event.data?.reference || 'n/a'}`,
      );
      const io = req.app.get('io');

      if (event.event === 'charge.success') {
        await WebhookController.handleChargeSuccess(event, io);
      } else if (event.event === 'charge.failed' || event.event === 'charge.abandoned') {
        await WebhookController.handleChargeFailed(event, io);
      }

    } catch (err) {
      console.error('[Webhook] Paystack processing error:', err.message);
    }
  }

  static async handleChargeSuccess(event, io) {
    const data    = event.data;
    const orderId = data?.metadata?.orderId;

    if (!orderId) return;

    if (data.authorization?.reusable) {
      const auth = data.authorization;
      await pool.query(
        `INSERT INTO saved_cards
           (user_id, paystack_authorization_code, last4, card_type, bank, exp_month, exp_year, is_default)
         VALUES ($1, $2, $3, $4, $5, $6, $7, false)
         ON CONFLICT (paystack_authorization_code) DO NOTHING`,
        [
          data.metadata?.userId,
          auth.authorization_code,
          auth.last4,
          auth.card_type,
          auth.bank,
          auth.exp_month,
          auth.exp_year,
        ],
      ).catch(() => {});
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
         SET status = 'paid', payment_status = 'paid', payment_method = 'card', updated_at = NOW()
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

      if (io) {
        io.to(`user:${userId}`).emit('payment_confirmed', { orderId });
        io.to(`order:${orderId}`).emit('order_update', { orderId, status: 'paid' });
        io.to('driver_pool').emit('new_order_available', { orderId, isCashDelivery: false });
      }

    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[Webhook] handleChargeSuccess error:', err.message);
    } finally {
      client.release();
    }
  }

  static async handleChargeFailed(event, io) {
    const orderId = event.data?.metadata?.orderId;
    if (!orderId) return;

    console.log(
      `[Webhook] Payment transition pending->failed orderId=${orderId} reference=${event.data?.reference || 'n/a'} event=${event.event || 'unknown'}`,
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

      // Only mark failed when not already paid to prevent out-of-order overwrites.
      await client.query(
        `UPDATE orders
         SET payment_status = 'failed', updated_at = NOW()
         WHERE id = $1 AND payment_status <> 'paid'`,
        [orderId],
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[Webhook] handleChargeFailed error:', err.message);
      return;
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

  static async handlePayflex(req, res) {
    const { orderId, status } = req.body;
    const io = req.app.get('io');

    const payflexSecret = process.env.PAYFLEX_WEBHOOK_SECRET;
    if (payflexSecret) {
      const incomingSecret = req.headers['x-payflex-signature'];
      if (incomingSecret !== payflexSecret) {
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
      if (status === 'APPROVED') {
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
             SET status = 'paid', payment_status = 'paid', updated_at = NOW()
             WHERE id = $1
             RETURNING user_id`,
            [orderId],
          );

          await client.query('COMMIT');

          if (io && result.rows.length) {
            io.to(`user:${result.rows[0].user_id}`).emit('payment_confirmed', { orderId });
            io.to('driver_pool').emit('new_order_available', { orderId, isCashDelivery: false });
          }
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
