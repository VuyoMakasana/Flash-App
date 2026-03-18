const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const { authenticate, requireRole } = require('../middleware/auth');

// Admin login (separate from user/driver)
// Part 1 Fix 4: Removed insecure plain-text comparison.
// Now uses bcrypt.compare against a hash of ADMIN_PASSWORD_HASH from .env.
// Run: node -e "require('bcryptjs').hash('yourpassword',12).then(console.log)" to generate.
// Falls back to plain-text comparison if ADMIN_PASSWORD_HASH not yet set (dev only).
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (email !== process.env.ADMIN_EMAIL) return res.status(401).json({ error: 'Invalid credentials' });

  try {
    let isValid = false;

    if (process.env.ADMIN_PASSWORD_HASH) {
      // Secure path: compare against stored bcrypt hash
      isValid = await bcrypt.compare(password, process.env.ADMIN_PASSWORD_HASH);
    } else if (process.env.NODE_ENV !== 'production') {
      // Dev fallback only — plain text (warns loudly)
      console.warn('[SECURITY] ADMIN_PASSWORD_HASH not set. Using plain-text comparison. Set it before production!');
      isValid = (password === process.env.ADMIN_PASSWORD);
    }

    if (!isValid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ id: 'admin', role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '8h' });
    res.json({ token });
  } catch (err) {
    console.error('Admin login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// GET all drivers (with filter by status)
router.get('/drivers', authenticate, requireRole('admin'), async (req, res) => {
  const { status } = req.query;
  try {
    const query = status
      ? 'SELECT id, name, email, phone, vehicle_type, status, created_at FROM drivers WHERE status=$1 ORDER BY created_at DESC'
      : 'SELECT id, name, email, phone, vehicle_type, status, created_at FROM drivers ORDER BY created_at DESC';

    const result = await pool.query(query, status ? [status] : []);
    res.json({ drivers: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch drivers' });
  }
});

// GET single driver with all documents
router.get('/drivers/:driverId', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const driver = await pool.query('SELECT * FROM drivers WHERE id=$1', [req.params.driverId]);
    if (!driver.rows.length) return res.status(404).json({ error: 'Driver not found' });

    const docs = await pool.query('SELECT * FROM driver_documents WHERE driver_id=$1', [req.params.driverId]);

    res.json({ driver: driver.rows[0], documents: docs.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch driver' });
  }
});

// APPROVE / REJECT driver
router.put('/drivers/:driverId/status', authenticate, requireRole('admin'), async (req, res) => {
  const { status, notes } = req.body;
  const validStatuses = ['under_review', 'approved', 'rejected'];

  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: `Status must be one of: ${validStatuses.join(', ')}` });
  }

  try {
    await pool.query(
      'UPDATE drivers SET status=$1, updated_at=NOW() WHERE id=$2',
      [status, req.params.driverId]
    );

    // Note: driver payouts handled via Paystack Transfer API when ready
    // See dashboard.paystack.com → Transfers for manual or automated payouts

    res.json({ success: true, status });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update driver status' });
  }
});

// GET all orders (admin dashboard)
router.get('/orders', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT o.id, o.order_number, o.status, o.total, o.payment_method, o.created_at,
              u.name as user_name, d.name as driver_name
       FROM orders o
       LEFT JOIN users u ON u.id = o.user_id
       LEFT JOIN drivers d ON d.id = o.driver_id
       ORDER BY o.created_at DESC LIMIT 100`
    );
    res.json({ orders: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// GET stats
router.get('/stats', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const [users, drivers, orders, revenue] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM users'),
      pool.query("SELECT COUNT(*) FROM drivers WHERE status='approved'"),
      pool.query('SELECT COUNT(*) FROM orders'),
      pool.query("SELECT COALESCE(SUM(total),0) as total FROM orders WHERE payment_status='paid'"),
    ]);

    res.json({
      totalUsers: parseInt(users.rows[0].count),
      approvedDrivers: parseInt(drivers.rows[0].count),
      totalOrders: parseInt(orders.rows[0].count),
      totalRevenue: parseFloat(revenue.rows[0].total),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

module.exports = router;
