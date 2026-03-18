const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { authenticate, requireRole } = require('../middleware/auth');

// Flash acts as its own store (Flash Closet)
const FLASH_STORE_ID = 'flash_closet';

// ─── GET FLASH INVENTORY ──────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const { category, page = 1, limit = 20 } = req.query;
  const offset = (page - 1) * limit;
  try {
    const query = category
      ? `SELECT * FROM flash_inventory WHERE is_active=true AND category=$3 ORDER BY created_at DESC LIMIT $1 OFFSET $2`
      : `SELECT * FROM flash_inventory WHERE is_active=true ORDER BY created_at DESC LIMIT $1 OFFSET $2`;
    const params = category ? [limit, offset, category] : [limit, offset];
    const result = await pool.query(query, params);
    res.json({ products: result.rows, storeId: FLASH_STORE_ID });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch inventory' });
  }
});

// ─── GET SINGLE PRODUCT ───────────────────────────────────────────────────────
router.get('/:productId', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM flash_inventory WHERE id=$1 AND is_active=true', [req.params.productId]);
    if (!result.rows.length) return res.status(404).json({ error: 'Product not found' });
    res.json({ product: result.rows[0], storeId: FLASH_STORE_ID });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch product' });
  }
});

// ─── ADD TO INVENTORY (admin only) ───────────────────────────────────────────
router.post('/', authenticate, requireRole('admin'), async (req, res) => {
  const { product_name, category, brand, price, cost_price, sizes, stock_by_size, image_url, description } = req.body;
  if (!product_name || !price) return res.status(400).json({ error: 'product_name and price required' });
  try {
    const result = await pool.query(
      `INSERT INTO flash_inventory (product_name, category, brand, price, cost_price, sizes, stock_by_size, image_url, description)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [product_name, category, brand, price, cost_price, JSON.stringify(sizes || []), JSON.stringify(stock_by_size || {}), image_url, description]
    );
    res.status(201).json({ product: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add product' });
  }
});

// ─── UPDATE STOCK ─────────────────────────────────────────────────────────────
router.patch('/:productId/stock', authenticate, requireRole('admin'), async (req, res) => {
  const { stock_by_size } = req.body;
  try {
    const result = await pool.query(
      `UPDATE flash_inventory SET stock_by_size=$1, updated_at=NOW() WHERE id=$2 RETURNING *`,
      [JSON.stringify(stock_by_size), req.params.productId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Product not found' });
    res.json({ product: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update stock' });
  }
});

// ─── DELETE / DEACTIVATE ──────────────────────────────────────────────────────
router.delete('/:productId', authenticate, requireRole('admin'), async (req, res) => {
  try {
    await pool.query(`UPDATE flash_inventory SET is_active=false, updated_at=NOW() WHERE id=$1`, [req.params.productId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove product' });
  }
});

module.exports = router;
