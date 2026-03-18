const express  = require('express');
const router   = express.Router();
const https    = require('https');
const pool     = require('../db/pool');
const { authenticate, requireRole } = require('../middleware/auth');

// ─── Paystack helper ──────────────────────────────────────────────────────────
// Paystack uses a simple REST API — no SDK needed, just HTTPS calls with the
// secret key in the Authorization header.
function paystackRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.paystack.co',
      port:     443,
      path,
      method,
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid Paystack response')); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ─── INITIALISE PAYMENT (Paystack Popup / redirect flow) ─────────────────────
// Frontend calls this, gets back an authorization_url.
// User is redirected to Paystack hosted page to enter card details securely.
// After payment, Paystack redirects to callback_url and fires a webhook.
router.post('/initialize', authenticate, requireRole('user'), async (req, res) => {
  const { orderId } = req.body;
  try {
    const orderResult = await pool.query(
      'SELECT id, total, subtotal, user_id, payment_status FROM orders WHERE id=$1',
      [orderId]
    );
    if (!orderResult.rows.length) return res.status(404).json({ error: 'Order not found' });
    const order = orderResult.rows[0];
    if (order.user_id !== req.userId) return res.status(403).json({ error: 'Not your order' });
    if (order.payment_status === 'paid') return res.status(400).json({ error: 'Order already paid' });

    // Fetch user email (Paystack requires it)
    const userResult = await pool.query('SELECT email FROM users WHERE id=$1', [req.userId]);
    const email = userResult.rows[0]?.email;

    // Amount in kobo (Paystack uses smallest currency unit — for ZAR that's cents)
    const amountInCents = Math.round(parseFloat(order.total) * 100);

    const paystackRes = await paystackRequest('POST', '/transaction/initialize', {
      email,
      amount:       amountInCents,
      currency:     'ZAR',
      reference:    `flash_${orderId}_${Date.now()}`,
      callback_url: `${process.env.APP_URL || 'https://your-app.com'}/payment/callback`,
      metadata: {
        orderId,
        userId:   req.userId,
        platform: 'flash',
      },
    });

    if (!paystackRes.status) {
      return res.status(400).json({ error: paystackRes.message || 'Paystack initialization failed' });
    }

    // Save the reference so the webhook can match it to this order
    await pool.query(
      'UPDATE orders SET paystack_reference=$1, status=$2, updated_at=NOW() WHERE id=$3',
      [paystackRes.data.reference, 'payment_pending', orderId]
    );

    res.json({
      authorizationUrl: paystackRes.data.authorization_url,
      reference:        paystackRes.data.reference,
      accessCode:       paystackRes.data.access_code,
      amount:           order.total,
    });
  } catch (err) {
    console.error('[Paystack] Initialize error:', err);
    res.status(500).json({ error: 'Failed to initialize payment' });
  }
});

// ─── VERIFY PAYMENT (called after redirect callback) ─────────────────────────
// After Paystack redirects the user back, the app calls this to confirm success.
router.get('/verify/:reference', authenticate, async (req, res) => {
  try {
    const paystackRes = await paystackRequest(
      'GET',
      `/transaction/verify/${encodeURIComponent(req.params.reference)}`
    );

    if (!paystackRes.status || paystackRes.data?.status !== 'success') {
      return res.status(400).json({ error: 'Payment not successful', details: paystackRes.data?.gateway_response });
    }

    const orderId = paystackRes.data?.metadata?.orderId;
    if (!orderId) return res.status(400).json({ error: 'No order linked to this payment' });

    const io = req.app.get('io');
    const result = await pool.query(
      `UPDATE orders SET status='paid', payment_status='paid', payment_method='card', updated_at=NOW()
       WHERE id=$1 AND paystack_reference=$2 RETURNING user_id`,
      [orderId, req.params.reference]
    );

    if (result.rows.length) {
      await pool.query(
        `INSERT INTO payments (order_id, user_id, amount, method, provider, provider_transaction_id, status, type)
         VALUES ($1,$2,$3,'card','paystack',$4,'paid','store')`,
        [orderId, result.rows[0].user_id, paystackRes.data.amount / 100, paystackRes.data.id]
      );
      if (io) {
        io.to(`user:${result.rows[0].user_id}`).emit('payment_confirmed', { orderId });
        io.to(`order:${orderId}`).emit('order_update', { orderId, status: 'paid' });
        io.to('driver_pool').emit('new_order_available', { orderId, isCashDelivery: false });
      }
    }

    res.json({ success: true, orderId });
  } catch (err) {
    console.error('[Paystack] Verify error:', err);
    res.status(500).json({ error: 'Failed to verify payment' });
  }
});

// ─── CASH ON DELIVERY ─────────────────────────────────────────────────────────
router.post('/cash-on-delivery', authenticate, requireRole('user'), async (req, res) => {
  const { orderId } = req.body;
  const io = req.app.get('io');
  try {
    const orderResult = await pool.query(
      'SELECT id, delivery_fee, driver_payout, user_id, status FROM orders WHERE id=$1',
      [orderId]
    );
    if (!orderResult.rows.length) return res.status(404).json({ error: 'Order not found' });
    const order = orderResult.rows[0];
    if (order.user_id !== req.userId) return res.status(403).json({ error: 'Not your order' });

    await pool.query(
      `UPDATE orders SET status='paid', delivery_payment_method='cash',
       delivery_payment_status='pending_collection', is_cash_delivery=true, updated_at=NOW()
       WHERE id=$1`,
      [orderId]
    );
    await pool.query(
      `INSERT INTO payments (order_id, user_id, amount, method, provider, status, type)
       VALUES ($1,$2,$3,'cash','cash_on_delivery','pending_collection','delivery')`,
      [orderId, req.userId, order.delivery_fee]
    );

    if (io) {
      io.to('driver_pool').emit('new_order_available', {
        orderId,
        isCashDelivery: true,
        deliveryFee:    order.delivery_fee,
        cashNote:       `Cash delivery — collect R${parseFloat(order.driver_payout || 0).toFixed(2)} on arrival`,
      });
    }

    res.json({ success: true, paymentMethod: 'cash', isCashDelivery: true, deliveryFee: order.delivery_fee });
  } catch (err) {
    res.status(500).json({ error: 'Failed to set cash delivery' });
  }
});

// ─── PAYFLEX BNPL ─────────────────────────────────────────────────────────────
router.post('/payflex/initiate', authenticate, requireRole('user'), async (req, res) => {
  const { orderId } = req.body;
  try {
    const orderResult = await pool.query('SELECT id, subtotal, user_id FROM orders WHERE id=$1', [orderId]);
    if (!orderResult.rows.length) return res.status(404).json({ error: 'Order not found' });
    const order = orderResult.rows[0];
    if (order.user_id !== req.userId) return res.status(403).json({ error: 'Not your order' });

    const payflexUrl = `https://checkout.payflex.co.za/?token=${process.env.PAYFLEX_API_KEY}&orderId=${orderId}`;
    await pool.query(
      'UPDATE orders SET payflex_order_id=$1, payment_method=$2, updated_at=NOW() WHERE id=$3',
      [orderId, 'payflex', orderId]
    );
    res.json({ checkoutUrl: payflexUrl, payflexOrderId: orderId });
  } catch (err) {
    res.status(500).json({ error: 'Failed to initiate Payflex' });
  }
});

// ─── GET PAYMENT STATUS ───────────────────────────────────────────────────────
router.get('/status/:orderId', authenticate, requireRole('user'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, payment_status, payment_method, delivery_payment_method,
              delivery_payment_status, status
       FROM orders WHERE id=$1 AND user_id=$2`,
      [req.params.orderId, req.userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Order not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch payment status' });
  }
});

// ─── GET SAVED CARDS ──────────────────────────────────────────────────────────
// Saved cards are stored by Paystack authorization_code after first payment.
// The user doesn't re-enter card details — Paystack handles it securely.
router.get('/cards', authenticate, requireRole('user'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, paystack_authorization_code, last4, card_type as brand,
              exp_month, exp_year, bank, nickname, is_default
       FROM saved_cards WHERE user_id=$1 ORDER BY is_default DESC, created_at DESC`,
      [req.userId]
    );
    res.json({ cards: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch cards' });
  }
});

// ─── REMOVE CARD ─────────────────────────────────────────────────────────────
router.delete('/cards/:cardId', authenticate, requireRole('user'), async (req, res) => {
  try {
    const cardResult = await pool.query(
      'SELECT id, is_default FROM saved_cards WHERE id=$1 AND user_id=$2',
      [req.params.cardId, req.userId]
    );
    if (!cardResult.rows.length) return res.status(404).json({ error: 'Card not found' });
    await pool.query('DELETE FROM saved_cards WHERE id=$1', [req.params.cardId]);
    // If deleted card was default, promote the next most recent one
    if (cardResult.rows[0].is_default) {
      await pool.query(
        `UPDATE saved_cards SET is_default=true
         WHERE user_id=$1 AND id=(SELECT id FROM saved_cards WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1)`,
        [req.userId]
      );
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove card' });
  }
});

// ─── SET DEFAULT CARD ─────────────────────────────────────────────────────────
router.patch('/cards/:cardId/default', authenticate, requireRole('user'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE saved_cards SET is_default=false WHERE user_id=$1', [req.userId]);
    const result = await client.query(
      'UPDATE saved_cards SET is_default=true WHERE id=$1 AND user_id=$2 RETURNING id',
      [req.params.cardId, req.userId]
    );
    if (!result.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Card not found' });
    }
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Failed to set default card' });
  } finally {
    client.release();
  }
});

module.exports = router;
