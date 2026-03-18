const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { authenticate, requireRole } = require('../middleware/auth');

const BOOST_PLANS = {
  search_top:   { price: 500,  days: 7,  label: 'Top of Search',    description: 'Appear first in all search results for 7 days' },
  homepage:     { price: 1500, days: 7,  label: 'Homepage Feature',  description: 'Featured store slot on homepage for 7 days' },
  flash_sale:   { price: 800,  days: 3,  label: 'Flash Sale Badge',  description: 'Run a flash sale with push notification blast' },
  monthly:      { price: 3500, days: 30, label: 'Monthly Premium',   description: 'All boost features for a full month' },
};

// ─── GET ACTIVE BOOSTS (for homepage/search to use) ──────────────────────────
router.get('/active', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM store_boosts WHERE status='active' AND expires_at>NOW() ORDER BY created_at DESC`
    );
    res.json({ boosts: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch boosts' });
  }
});

// ─── GET ACTIVE PROMOTIONS ────────────────────────────────────────────────────
router.get('/promotions', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM store_promotions WHERE is_active=true AND expires_at>NOW() ORDER BY created_at DESC`
    );
    res.json({ promotions: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch promotions' });
  }
});

// ─── PURCHASE BOOST ───────────────────────────────────────────────────────────
router.post('/purchase', authenticate, async (req, res) => {
  const { storeId, storeName, boostType } = req.body;
  const plan = BOOST_PLANS[boostType];
  if (!plan) return res.status(400).json({ error: `Invalid boost type. Choose: ${Object.keys(BOOST_PLANS).join(', ')}` });

  try {
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + plan.days);

    const result = await pool.query(
      `INSERT INTO store_boosts (store_id, store_name, boost_type, price_paid, starts_at, expires_at, status) VALUES ($1,$2,$3,$4,NOW(),$5,'active') RETURNING *`,
      [storeId, storeName, boostType, plan.price, expiresAt]
    );
    res.status(201).json({ boost: result.rows[0], message: `${plan.label} activated for ${plan.days} days` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create boost' });
  }
});

// ─── CREATE PROMOTION ─────────────────────────────────────────────────────────
router.post('/promotions', authenticate, async (req, res) => {
  const { storeId, title, description, discountPercent, durationDays } = req.body;
  if (!storeId || !title) return res.status(400).json({ error: 'storeId and title required' });
  try {
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + (durationDays || 7));

    const result = await pool.query(
      `INSERT INTO store_promotions (store_id, title, description, discount_percent, starts_at, expires_at) VALUES ($1,$2,$3,$4,NOW(),$5) RETURNING *`,
      [storeId, title, description, discountPercent || null, expiresAt]
    );
    res.status(201).json({ promotion: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create promotion' });
  }
});

// ─── AVAILABLE BOOST PLANS ────────────────────────────────────────────────────
router.get('/plans', (req, res) => {
  res.json({ plans: Object.entries(BOOST_PLANS).map(([id, p]) => ({ id, ...p })) });
});

module.exports = router;
