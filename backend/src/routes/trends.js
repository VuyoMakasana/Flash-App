const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { authenticate, requireRole } = require('../middleware/auth');

// ─── TRENDS BY CITY ───────────────────────────────────────────────────────────
router.get('/city', authenticate, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT city, category, COUNT(*) as browse_count,
             COUNT(DISTINCT user_id) as unique_users
      FROM browsing_events
      WHERE created_at > NOW() - INTERVAL '7 days' AND city IS NOT NULL
      GROUP BY city, category
      ORDER BY browse_count DESC
      LIMIT 50
    `);
    res.json({ trends: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch city trends' });
  }
});

// ─── TRENDS BY CATEGORY ───────────────────────────────────────────────────────
router.get('/category', authenticate, async (req, res) => {
  const { days = 7 } = req.query;
  try {
    const result = await pool.query(`
      SELECT category,
             COUNT(*) as browse_count,
             COUNT(DISTINCT user_id) as unique_users,
             AVG(duration_seconds) as avg_view_time
      FROM browsing_events
      WHERE created_at > NOW() - INTERVAL '${parseInt(days)} days'
        AND category IS NOT NULL
      GROUP BY category
      ORDER BY browse_count DESC
    `);
    res.json({ trends: result.rows, period_days: parseInt(days) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch category trends' });
  }
});

// ─── TRENDS BY PRICE ──────────────────────────────────────────────────────────
router.get('/price', authenticate, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        CASE
          WHEN oi.unit_price < 300 THEN 'Under R300'
          WHEN oi.unit_price < 600 THEN 'R300-R600'
          WHEN oi.unit_price < 1000 THEN 'R600-R1000'
          WHEN oi.unit_price < 2000 THEN 'R1000-R2000'
          ELSE 'Over R2000'
        END as price_band,
        COUNT(*) as units_sold,
        SUM(oi.total_price) as revenue
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE o.status IN ('completed','delivered')
        AND o.created_at > NOW() - INTERVAL '30 days'
      GROUP BY price_band
      ORDER BY units_sold DESC
    `);
    res.json({ trends: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch price trends' });
  }
});

// ─── TOP PRODUCTS ─────────────────────────────────────────────────────────────
router.get('/top-products', authenticate, async (req, res) => {
  const { days = 30, limit = 10 } = req.query;
  try {
    const result = await pool.query(`
      SELECT oi.product_id, oi.product_name,
             COUNT(*) as times_ordered,
             SUM(oi.quantity) as units_sold,
             SUM(oi.total_price) as total_revenue
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE o.status IN ('completed','delivered')
        AND o.created_at > NOW() - INTERVAL '${parseInt(days)} days'
      GROUP BY oi.product_id, oi.product_name
      ORDER BY units_sold DESC
      LIMIT $1
    `, [parseInt(limit)]);
    res.json({ products: result.rows, period_days: parseInt(days) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch top products' });
  }
});

// ─── RECORD BROWSING EVENT (called by user app) ───────────────────────────────
router.post('/browse', authenticate, requireRole('user'), async (req, res) => {
  const { productId, category, lat, lng, city, durationSeconds } = req.body;
  try {
    await pool.query(
      `INSERT INTO browsing_events (user_id, product_id, category, lat, lng, city, duration_seconds) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [req.userId, productId || null, category || null, lat || null, lng || null, city || null, durationSeconds || 0]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to record browse event' });
  }
});

module.exports = router;
