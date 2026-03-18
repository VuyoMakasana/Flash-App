const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { authenticate, requireRole } = require('../middleware/auth');

// ─── REQUEST RETURN ───────────────────────────────────────────────────────────
router.post('/:orderId', authenticate, requireRole('user'), async (req, res) => {
  const { reason } = req.body;
  const io = req.app.get('io');
  try {
    const order = await pool.query(
      'SELECT id, status, user_id, subtotal, delivery_fee FROM orders WHERE id=$1',
      [req.params.orderId]
    );
    if (!order.rows.length) return res.status(404).json({ error: 'Order not found' });
    if (order.rows[0].user_id !== req.userId) return res.status(403).json({ error: 'Not your order' });
    if (!['delivered','completed'].includes(order.rows[0].status)) {
      return res.status(400).json({ error: 'Can only return delivered orders' });
    }

    const result = await pool.query(
      `INSERT INTO return_requests (order_id, user_id, reason) VALUES ($1,$2,$3)
       ON CONFLICT (order_id) DO NOTHING RETURNING *`,
      [req.params.orderId, req.userId, reason || null]
    );

    if (!result.rows.length) return res.status(409).json({ error: 'Return already requested for this order' });

    res.status(201).json({ returnRequest: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to request return' });
  }
});

// ─── DRIVER PICKS UP RETURN → INSTANT STORE CREDIT ISSUED ────────────────────
router.post('/:returnId/pickup', authenticate, requireRole('driver'), async (req, res) => {
  const io = req.app.get('io');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const returnResult = await client.query(
      `SELECT rr.*, o.subtotal, o.user_id FROM return_requests rr
       JOIN orders o ON o.id = rr.order_id
       WHERE rr.id=$1 AND rr.status='requested'`,
      [req.params.returnId]
    );
    if (!returnResult.rows.length) return res.status(404).json({ error: 'Return not found or already processed' });
    const ret = returnResult.rows[0];

    // Assign driver and mark picked up
    await client.query(
      `UPDATE return_requests SET driver_id=$1, status='picked_up', picked_up_at=NOW(), updated_at=NOW() WHERE id=$2`,
      [req.userId, req.params.returnId]
    );

    // Issue instant store credit for the subtotal amount
    const creditAmount = parseFloat(ret.subtotal);
    await client.query(
      `INSERT INTO store_credits (user_id, return_id, amount, balance, reason, expires_at)
       VALUES ($1,$2,$3,$3,'Return credit — reorder any time',NOW() + INTERVAL '90 days')`,
      [ret.user_id, req.params.returnId, creditAmount]
    );

    // Mark credit as issued on the return
    await client.query(
      `UPDATE return_requests SET credit_issued=true, credit_amount=$1, updated_at=NOW() WHERE id=$2`,
      [creditAmount, req.params.returnId]
    );

    await client.query('COMMIT');

    // Notify user instantly via socket
    if (io) {
      io.to(`user:${ret.user_id}`).emit('return_credit_issued', {
        returnId: req.params.returnId,
        creditAmount,
        message: `R${creditAmount.toFixed(2)} store credit added to your account. Use it on your next order!`,
      });
    }

    res.json({
      success: true,
      creditIssued: creditAmount,
      message: `Return picked up. R${creditAmount.toFixed(2)} instant credit issued to customer.`,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Return pickup error:', err);
    res.status(500).json({ error: 'Failed to process return pickup' });
  } finally {
    client.release();
  }
});

// ─── GET USER STORE CREDITS ───────────────────────────────────────────────────
router.get('/credits', authenticate, requireRole('user'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, amount, balance, reason, expires_at, created_at
       FROM store_credits
       WHERE user_id=$1 AND balance > 0 AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY created_at DESC`,
      [req.userId]
    );
    const total = result.rows.reduce((sum, c) => sum + parseFloat(c.balance), 0);
    res.json({ credits: result.rows, totalBalance: total.toFixed(2) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch store credits' });
  }
});

// ─── GET MY RETURN REQUESTS ────────────────────────────────────────────────────
router.get('/my', authenticate, requireRole('user'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT rr.*, o.order_number, o.subtotal FROM return_requests rr
       JOIN orders o ON o.id = rr.order_id
       WHERE rr.user_id=$1 ORDER BY rr.created_at DESC`,
      [req.userId]
    );
    res.json({ returns: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch returns' });
  }
});

module.exports = router;
