const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { authenticate, requireRole } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

// ─────────────────────────────────────────
// CREATE ORDER
// ─────────────────────────────────────────
router.post('/', authenticate, requireRole('user'), async (req, res) => {
  const {
    items,
    delivery_mode,
    time_slot,
    subtotal,
    delivery_fee,
    total,
    pickup_address,
    dropoff_address,
    pickup_lat,
    pickup_lng,
    dropoff_lat,
    dropoff_lng,
  } = req.body;

  if (!items?.length) return res.status(400).json({ error: 'Order must have items' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const orderNumber = `FLASH-${Date.now().toString(36).toUpperCase()}`;
    const driverPayout = Math.round((delivery_fee * 0.75 + 15) * 100) / 100;

    const orderResult = await client.query(
      `INSERT INTO orders (
        order_number, user_id, status, delivery_mode, time_slot,
        subtotal, delivery_fee, total, driver_payout,
        pickup_address, dropoff_address,
        pickup_lat, pickup_lng, dropoff_lat, dropoff_lng
       ) VALUES ($1, $2, 'payment_pending', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING *`,
      [
        orderNumber, req.userId, delivery_mode, time_slot,
        subtotal, delivery_fee, total, driverPayout,
        pickup_address, dropoff_address,
        pickup_lat, pickup_lng, dropoff_lat, dropoff_lng,
      ]
    );

    const order = orderResult.rows[0];

    // Insert items
    for (const item of items) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, product_name, size, quantity, unit_price, total_price)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [order.id, item.productId, item.name, item.size, item.quantity, item.price, item.price * item.quantity]
      );
    }

    await client.query('COMMIT');

    res.status(201).json({ order, orderNumber });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to create order' });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────
// GET USER ORDERS
// ─────────────────────────────────────────
router.get('/my-orders', authenticate, requireRole('user'), async (req, res) => {
  // Paginate: ?page=1&limit=20 (default limit 20, max 50)
  const page  = Math.max(1, parseInt(req.query.page  || '1'));
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '20')));
  const offset = (page - 1) * limit;

  try {
    const result = await pool.query(
      `SELECT o.*,
              d.name as driver_name, d.phone as driver_phone,
              d.vehicle_type as driver_vehicle, d.profile_photo_url as driver_photo,
              d.rating as driver_rating,
              d.current_lat as driver_lat, d.current_lng as driver_lng,
              json_agg(json_build_object(
                'id', oi.id, 'product_id', oi.product_id, 'product_name', oi.product_name,
                'size', oi.size, 'quantity', oi.quantity, 'unit_price', oi.unit_price, 'total_price', oi.total_price
              )) as items
       FROM orders o
       LEFT JOIN drivers d ON d.id = o.driver_id
       LEFT JOIN order_items oi ON oi.order_id = o.id
       WHERE o.user_id = $1
       GROUP BY o.id, d.id
       ORDER BY o.created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.userId, limit, offset]
    );

    res.json({ orders: result.rows, page, limit, hasMore: result.rows.length === limit });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// ─────────────────────────────────────────
// GET SINGLE ORDER
// ─────────────────────────────────────────
router.get('/:orderId', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT o.*,
              d.name as driver_name, d.phone as driver_phone,
              d.vehicle_type as driver_vehicle, d.profile_photo_url as driver_photo,
              d.rating as driver_rating, d.current_lat as driver_lat, d.current_lng as driver_lng,
              json_agg(json_build_object(
                'product_name', oi.product_name, 'size', oi.size,
                'quantity', oi.quantity, 'total_price', oi.total_price
              )) as items
       FROM orders o
       LEFT JOIN drivers d ON d.id = o.driver_id
       LEFT JOIN order_items oi ON oi.order_id = o.id
       WHERE o.id = $1
       GROUP BY o.id, d.id`,
      [req.params.orderId]
    );

    if (!result.rows.length) return res.status(404).json({ error: 'Order not found' });

    const order = result.rows[0];

    // Only the user or the assigned driver can view this order
    const canView =
      (req.userRole === 'user' && order.user_id === req.userId) ||
      (req.userRole === 'driver' && order.driver_id === req.userId) ||
      req.userRole === 'admin';

    if (!canView) return res.status(403).json({ error: 'Access denied' });

    res.json({ order });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch order' });
  }
});

// ─────────────────────────────────────────
// UPDATE ORDER STATUS (driver only)
// ─────────────────────────────────────────
const VALID_TRANSITIONS = {
  driver_assigned: ['en_route'],
  en_route: ['picked_up'],
  picked_up: ['delivered'],
  delivered: ['completed'],
};

router.put('/:orderId/status', authenticate, requireRole('driver'), async (req, res) => {
  const { status } = req.body;
  const io = req.app.get('io');

  try {
    const current = await pool.query(
      'SELECT status, driver_id, user_id FROM orders WHERE id = $1',
      [req.params.orderId]
    );

    if (!current.rows.length) return res.status(404).json({ error: 'Order not found' });
    const order = current.rows[0];

    if (order.driver_id !== req.userId) {
      return res.status(403).json({ error: 'Not your order' });
    }

    const allowedNext = VALID_TRANSITIONS[order.status] || [];
    if (!allowedNext.includes(status)) {
      return res.status(400).json({ error: `Cannot transition from ${order.status} to ${status}` });
    }

    await pool.query(
      'UPDATE orders SET status=$1, updated_at=NOW() WHERE id=$2',
      [status, req.params.orderId]
    );

    // Notify user of status change
    if (io) {
      io.to(`order:${req.params.orderId}`).emit('order_update', {
        orderId: req.params.orderId,
        status,
        timestamp: new Date().toISOString(),
      });

      // Also notify user's personal room
      io.to(`user:${order.user_id}`).emit('order_update', {
        orderId: req.params.orderId,
        status,
      });
    }

    res.json({ success: true, status });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// ─────────────────────────────────────────
// REQUEST RETURN
// ─────────────────────────────────────────
router.post('/:orderId/return', authenticate, requireRole('user'), async (req, res) => {
  const { reason } = req.body;
  try {
    const order = await pool.query(
      'SELECT id, status, user_id FROM orders WHERE id = $1',
      [req.params.orderId]
    );

    if (!order.rows.length) return res.status(404).json({ error: 'Order not found' });
    if (order.rows[0].user_id !== req.userId) return res.status(403).json({ error: 'Not your order' });
    if (!['delivered', 'completed'].includes(order.rows[0].status)) {
      return res.status(400).json({ error: 'Can only return delivered orders' });
    }

    const result = await pool.query(
      `INSERT INTO return_requests (order_id, user_id, reason) VALUES ($1, $2, $3)
       ON CONFLICT (order_id) DO NOTHING RETURNING *`,
      [req.params.orderId, req.userId, reason || null]
    );

    if (!result.rows.length) {
      return res.status(409).json({ error: 'Return already requested' });
    }

    res.json({ returnRequest: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to request return' });
  }
});

module.exports = router;
