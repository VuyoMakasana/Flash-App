const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { authenticate } = require('../middleware/auth');

// Get driver's current location for an order
router.get('/order/:orderId', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT d.current_lat as lat, d.current_lng as lng, d.name as driver_name,
              d.vehicle_type, d.phone as driver_phone, d.profile_photo_url,
              o.status as order_status, o.dropoff_lat, o.dropoff_lng
       FROM orders o
       LEFT JOIN drivers d ON d.id = o.driver_id
       WHERE o.id = $1`,
      [req.params.orderId]
    );

    if (!result.rows.length) return res.status(404).json({ error: 'Order not found' });

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch location' });
  }
});

module.exports = router;
