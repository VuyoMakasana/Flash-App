const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { authenticate } = require('../middleware/auth');

// ─── Haversine distance helper (km) ──────────────────────────────────────────
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── GET MESSAGES for an order ───────────────────────────────────────────────
// Both user and driver can read — but only if they are part of the order.
router.get('/:orderId', authenticate, async (req, res) => {
  try {
    // Verify caller is part of this order
    const order = await pool.query(
      'SELECT user_id, driver_id FROM orders WHERE id=$1',
      [req.params.orderId]
    );
    if (!order.rows.length) return res.status(404).json({ error: 'Order not found' });
    const o = order.rows[0];
    const allowed =
      (req.userRole === 'user'   && o.user_id   === req.userId) ||
      (req.userRole === 'driver' && o.driver_id === req.userId) ||
      req.userRole === 'admin';
    if (!allowed) return res.status(403).json({ error: 'Access denied' });

    const msgs = await pool.query(
      `SELECT id, sender_id, sender_role, content, read_at, created_at
       FROM messages WHERE order_id=$1 ORDER BY created_at ASC`,
      [req.params.orderId]
    );

    // Mark unread messages as read for this caller
    await pool.query(
      `UPDATE messages SET read_at=NOW()
       WHERE order_id=$1 AND sender_role != $2 AND read_at IS NULL`,
      [req.params.orderId, req.userRole]
    );

    res.json({ messages: msgs.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// ─── SEND A MESSAGE ───────────────────────────────────────────────────────────
router.post('/:orderId', authenticate, async (req, res) => {
  const { content } = req.body;
  const io = req.app.get('io');

  if (!content?.trim()) return res.status(400).json({ error: 'Message content required' });
  if (content.length > 500) return res.status(400).json({ error: 'Message too long (max 500 chars)' });

  try {
    // Verify caller is part of this order
    const order = await pool.query(
      'SELECT user_id, driver_id FROM orders WHERE id=$1',
      [req.params.orderId]
    );
    if (!order.rows.length) return res.status(404).json({ error: 'Order not found' });
    const o = order.rows[0];
    const allowed =
      (req.userRole === 'user'   && o.user_id   === req.userId) ||
      (req.userRole === 'driver' && o.driver_id === req.userId);
    if (!allowed) return res.status(403).json({ error: 'Access denied' });

    const msg = await pool.query(
      `INSERT INTO messages (order_id, sender_id, sender_role, content)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.params.orderId, req.userId, req.userRole, content.trim()]
    );

    const newMsg = msg.rows[0];

    // Push message in real-time to the other party
    if (io) {
      io.to(`order:${req.params.orderId}`).emit('new_message', {
        orderId:    req.params.orderId,
        message:    newMsg,
      });
      // Also push to personal room of recipient
      const recipientId = req.userRole === 'user' ? o.driver_id : o.user_id;
      if (recipientId) {
        const recipientRole = req.userRole === 'user' ? 'driver' : 'user';
        io.to(`${recipientRole}:${recipientId}`).emit('new_message', {
          orderId: req.params.orderId,
          message: newMsg,
        });
      }
    }

    res.status(201).json({ message: newMsg });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// ─── UNREAD COUNT for a user/driver ──────────────────────────────────────────
router.get('/:orderId/unread', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT COUNT(*) as count FROM messages
       WHERE order_id=$1 AND sender_role != $2 AND read_at IS NULL`,
      [req.params.orderId, req.userRole]
    );
    res.json({ unread: parseInt(result.rows[0].count) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch unread count' });
  }
});

module.exports = router;
