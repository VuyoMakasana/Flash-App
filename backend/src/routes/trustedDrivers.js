const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { authenticate, requireRole } = require('../middleware/auth');

// ─── USER: Get my trusted drivers ────────────────────────────────────────────
router.get('/', authenticate, requireRole('user'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT td.id, td.status, td.created_at,
              d.id as driver_id, d.name, d.rating, d.total_deliveries,
              d.vehicle_type, d.profile_photo_url, d.is_online,
              -- Check if driver is currently on an active delivery
              EXISTS(
                SELECT 1 FROM orders o
                WHERE o.driver_id = d.id
                  AND o.status IN ('driver_assigned','en_route','picked_up')
              ) as is_busy
       FROM trusted_drivers td
       JOIN drivers d ON d.id = td.driver_id
       WHERE td.user_id = $1 AND td.status = 'accepted'
       ORDER BY td.created_at DESC`,
      [req.userId]
    );
    res.json({ trustedDrivers: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch trusted drivers' });
  }
});

// ─── USER: Get pending requests sent ─────────────────────────────────────────
router.get('/pending', authenticate, requireRole('user'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT td.id, td.status, td.created_at,
              d.id as driver_id, d.name, d.rating, d.vehicle_type
       FROM trusted_drivers td
       JOIN drivers d ON d.id = td.driver_id
       WHERE td.user_id = $1 AND td.status = 'pending'`,
      [req.userId]
    );
    res.json({ pending: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch pending requests' });
  }
});

// ─── USER: Send trust request to a driver ────────────────────────────────────
router.post('/:driverId/request', authenticate, requireRole('user'), async (req, res) => {
  const io = req.app.get('io');
  try {
    // Check driver exists and is approved
    const driver = await pool.query(
      "SELECT id, name FROM drivers WHERE id=$1 AND status='approved'",
      [req.params.driverId]
    );
    if (!driver.rows.length) return res.status(404).json({ error: 'Driver not found' });

    const result = await pool.query(
      `INSERT INTO trusted_drivers (user_id, driver_id, status)
       VALUES ($1, $2, 'pending')
       ON CONFLICT (user_id, driver_id) DO UPDATE SET status='pending', updated_at=NOW()
       RETURNING *`,
      [req.userId, req.params.driverId]
    );

    // Notify driver in real-time
    if (io) {
      io.to(`driver:${req.params.driverId}`).emit('trust_request', {
        type: 'trust_request',
        requestId: result.rows[0].id,
        userId: req.userId,
        message: 'A customer wants to add you as a trusted driver',
      });
    }

    res.status(201).json({ request: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send trust request' });
  }
});

// ─── USER: Remove a trusted driver ───────────────────────────────────────────
router.delete('/:driverId', authenticate, requireRole('user'), async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM trusted_drivers WHERE user_id=$1 AND driver_id=$2',
      [req.userId, req.params.driverId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove trusted driver' });
  }
});

// ─── DRIVER: Get pending trust requests ──────────────────────────────────────
router.get('/requests', authenticate, requireRole('driver'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT td.id, td.status, td.created_at,
              u.id as user_id, u.name as user_name
       FROM trusted_drivers td
       JOIN users u ON u.id = td.user_id
       WHERE td.driver_id = $1 AND td.status = 'pending'
       ORDER BY td.created_at DESC`,
      [req.userId]
    );
    res.json({ requests: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch requests' });
  }
});

// ─── DRIVER: Accept or decline a trust request ───────────────────────────────
router.patch('/:requestId/respond', authenticate, requireRole('driver'), async (req, res) => {
  const { action } = req.body; // 'accept' | 'decline'
  if (!['accept', 'decline'].includes(action)) {
    return res.status(400).json({ error: 'action must be accept or decline' });
  }
  const io = req.app.get('io');
  try {
    const newStatus = action === 'accept' ? 'accepted' : 'declined';
    const result = await pool.query(
      `UPDATE trusted_drivers SET status=$1, updated_at=NOW()
       WHERE id=$2 AND driver_id=$3
       RETURNING *`,
      [newStatus, req.params.requestId, req.userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Request not found' });

    // Notify the user of the response
    if (io) {
      io.to(`user:${result.rows[0].user_id}`).emit('trust_response', {
        driverId: req.userId,
        status: newStatus,
        message: action === 'accept'
          ? 'A driver accepted your trusted driver request!'
          : 'A driver declined your trusted driver request.',
      });
    }

    res.json({ success: true, status: newStatus });
  } catch (err) {
    res.status(500).json({ error: 'Failed to respond to request' });
  }
});

// ─── DRIVER: Remove themselves from someone's trusted list ───────────────────
router.delete('/remove-self/:userId', authenticate, requireRole('driver'), async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM trusted_drivers WHERE driver_id=$1 AND user_id=$2',
      [req.userId, req.params.userId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove self' });
  }
});

// ─── USER: Check if a specific trusted driver is available ───────────────────
router.get('/:driverId/status', authenticate, requireRole('user'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT d.id, d.name, d.is_online, d.rating, d.total_deliveries,
              d.vehicle_type, d.profile_photo_url,
              td.status as trust_status,
              EXISTS(
                SELECT 1 FROM orders o
                WHERE o.driver_id = d.id
                  AND o.status IN ('driver_assigned','en_route','picked_up')
              ) as is_busy
       FROM drivers d
       LEFT JOIN trusted_drivers td
         ON td.driver_id = d.id AND td.user_id = $1
       WHERE d.id = $2`,
      [req.userId, req.params.driverId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Driver not found' });
    res.json({ driver: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to check driver status' });
  }
});

module.exports = router;
