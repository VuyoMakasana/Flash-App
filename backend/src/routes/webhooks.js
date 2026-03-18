const express  = require('express');
const router   = express.Router();
const crypto   = require('crypto');
const pool     = require('../db/pool');

// ─── PAYSTACK WEBHOOK ─────────────────────────────────────────────────────────
// Paystack sends a POST to this URL after every payment event.
// Set this URL in dashboard.paystack.com → Settings → API Keys & Webhooks
// URL format: https://your-backend.onrender.com/api/webhooks/paystack
//
// Paystack signs each request with your secret key using HMAC-SHA512.
// We verify the signature before trusting anything in the body.
router.post('/paystack', express.json(), async (req, res) => {
  // Always respond 200 first — Paystack retries if it doesn't get 200 quickly
  res.sendStatus(200);

  try {
    // Verify signature
    const hash = crypto
      .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
      .update(JSON.stringify(req.body))
      .digest('hex');

    if (hash !== req.headers['x-paystack-signature']) {
      console.warn('[Webhook] Paystack signature mismatch — ignoring');
      return;
    }

    const event = req.body;
    const io    = req.app.get('io');

    if (event.event === 'charge.success') {
      const data    = event.data;
      const orderId = data?.metadata?.orderId;

      if (!orderId) return;

      // Save card authorization for future payments (charge without re-entering card)
      if (data.authorization?.reusable) {
        const auth = data.authorization;
        await pool.query(
          `INSERT INTO saved_cards
             (user_id, paystack_authorization_code, last4, card_type, bank, exp_month, exp_year, is_default)
           VALUES ($1,$2,$3,$4,$5,$6,$7,false)
           ON CONFLICT (paystack_authorization_code) DO NOTHING`,
          [
            data.metadata?.userId,
            auth.authorization_code,
            auth.last4,
            auth.card_type,
            auth.bank,
            auth.exp_month,
            auth.exp_year,
          ]
        ).catch(() => {}); // Non-fatal — don't block order confirmation if this fails
      }

      // Mark order as paid
      const result = await pool.query(
        `UPDATE orders
         SET status='paid', payment_status='paid', payment_method='card', updated_at=NOW()
         WHERE id=$1 AND paystack_reference=$2
         RETURNING user_id`,
        [orderId, data.reference]
      );

      if (result.rows.length) {
        const userId = result.rows[0].user_id;

        await pool.query(
          `INSERT INTO payments
             (order_id, user_id, amount, method, provider, provider_transaction_id, status, type)
           VALUES ($1,$2,$3,'card','paystack',$4,'paid','store')`,
          [orderId, userId, data.amount / 100, data.id]
        );

        if (io) {
          io.to(`user:${userId}`).emit('payment_confirmed', { orderId });
          io.to(`order:${orderId}`).emit('order_update', { orderId, status: 'paid' });
          // Only notify drivers — not all users
          io.to('driver_pool').emit('new_order_available', { orderId, isCashDelivery: false });
        }
      }
    }

    if (event.event === 'charge.failed') {
      const orderId = event.data?.metadata?.orderId;
      if (!orderId) return;

      await pool.query(
        `UPDATE orders SET payment_status='failed', updated_at=NOW() WHERE id=$1`,
        [orderId]
      );

      const orderRow = await pool.query('SELECT user_id FROM orders WHERE id=$1', [orderId]);
      if (io && orderRow.rows.length) {
        io.to(`user:${orderRow.rows[0].user_id}`).emit('payment_failed', {
          orderId,
          message: 'Your payment failed. Please try again.',
        });
      }
    }

  } catch (err) {
    console.error('[Webhook] Paystack processing error:', err.message);
  }
});

// ─── PAYFLEX WEBHOOK ─────────────────────────────────────────────────────────
router.post('/payflex', express.json(), async (req, res) => {
  const { orderId, status } = req.body;
  const io = req.app.get('io');
  try {
    if (status === 'APPROVED') {
      const result = await pool.query(
        `UPDATE orders SET status='paid', payment_status='paid', updated_at=NOW()
         WHERE id=$1 RETURNING user_id`,
        [orderId]
      );
      if (io && result.rows.length) {
        io.to(`user:${result.rows[0].user_id}`).emit('payment_confirmed', { orderId });
        io.to('driver_pool').emit('new_order_available', { orderId, isCashDelivery: false });
      }
    } else if (status === 'DECLINED' || status === 'CANCELLED') {
      await pool.query(
        `UPDATE orders SET payment_status='failed', updated_at=NOW() WHERE id=$1`,
        [orderId]
      );
    }
    res.json({ received: true });
  } catch (err) {
    console.error('[Webhook] Payflex error:', err.message);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

module.exports = router;
