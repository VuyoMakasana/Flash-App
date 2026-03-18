const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { authenticate, requireRole } = require('../middleware/auth');

// GET current user profile
router.get('/me', authenticate, requireRole('user'), async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, email, phone, address, terms_accepted, created_at FROM users WHERE id=$1',
      [req.userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
    res.json({ user: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// UPDATE user profile
router.put('/me', authenticate, requireRole('user'), async (req, res) => {
  const { name, phone, address } = req.body;
  try {
    const result = await pool.query(
      'UPDATE users SET name=$1, phone=$2, address=$3, updated_at=NOW() WHERE id=$4 RETURNING id, name, email, phone, address',
      [name, phone, address, req.userId]
    );
    res.json({ user: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

module.exports = router;
