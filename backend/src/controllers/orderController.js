// backend/src/controllers/orderController.js
//
// CHANGE FROM ORIGINAL:
//   createOrder now returns HTTP 400 (not 500) when Order.create() throws
//   a price-validation error. Previously, any throw from the model became
//   a 500 Internal Server Error, hiding the real cause from the client and
//   making it look like a server fault rather than a bad request.
//   The fix: inspect err.message for known validation strings and downgrade
//   to 400 so the user app can surface a meaningful error message.

const Order = require('../models/Order');
const Rating = require('../models/Rating');
const db = require('../config/database');
const DriverWallet = require('../models/DriverWallet');
const {
  updateOrderStatus,
  assignDriver,
  normalizeState,
  emitOrderUpdate,
  notifyOrderStatusChange,
} = require('../services/orderStateMachineService');
const RefundService = require('../services/refundService');
const { isWithinNelsonMandelaBay, OUTSIDE_SERVICE_AREA_MESSAGE, FLASH_STORE_LOCATION } = require('../utils/geoBoundary');

// Errors thrown by validateExternalItemPrice() and inventory stock checks
// start with one of these prefixes. Treat them as client errors (400) rather
// than server errors (500).
const CLIENT_ERROR_PREFIXES = [
  'Invalid price for',
  'Invalid quantity for',
  'is out of stock',
  'Order must have items',
  'Order total must be positive',
];

function isClientError(message) {
  if (!message) return false;
  return CLIENT_ERROR_PREFIXES.some((prefix) => message.startsWith(prefix));
}

class OrderController {
  static async createOrder(req, res) {
    const {
      items,
      delivery_mode,
      time_slot,
      subtotal,
      store_id,
      preferred_driver_id,
      requested_driver_id,
      pickup_mall_id,
      dropoff_mall_id,
      pickup_address,
      dropoff_address,
      dropoff_lat,
      dropoff_lng,
    } = req.body;

    if (!items?.length) {
      return res.status(400).json({ error: 'Order must have items' });
    }

    // Flash only operates within Nelson Mandela Bay — the Play Store can
    // restrict which countries install the app, but not which cities, so
    // this has to be enforced here. Pickup is always Flash's one fixed
    // store location (FLASH_STORE_LOCATION), not client-supplied — there is
    // no multi-vendor "stores" concept in this codebase, so trusting a
    // client-sent pickup coordinate for something that never changes would
    // just be an unnecessary way for a bad client to bypass this check.
    // Dropoff (the customer's actual delivery point) must be freshly
    // supplied and inside the boundary; missing coordinates are rejected
    // rather than silently allowed through unchecked.
    if (!isWithinNelsonMandelaBay(dropoff_lat, dropoff_lng)) {
      return res.status(400).json({ error: OUTSIDE_SERVICE_AREA_MESSAGE });
    }

    // Coalesce — preferred_driver_id (admin/backend) > requested_driver_id (user app)
    const resolvedPreferredDriverId = preferred_driver_id || requested_driver_id || null;

    try {
      const order = await Order.create({
        userId: req.userId,
        items,
        delivery_mode,
        time_slot,
        subtotal,
        store_id,
        preferred_driver_id: resolvedPreferredDriverId,
        pickup_mall_id,
        dropoff_mall_id,
        pickup_address,
        dropoff_address,
        pickup_lat: FLASH_STORE_LOCATION.lat,
        pickup_lng: FLASH_STORE_LOCATION.lng,
        dropoff_lat,
        dropoff_lng,
      });

      res.status(201).json({ order, orderNumber: order.order_number });
    } catch (err) {
      // Price validation and stock errors are client mistakes — return 400.
      // Everything else is an unexpected server fault — return 500.
      if (isClientError(err.message)) {
        return res.status(400).json({ error: err.message });
      }
      console.error('[Order] createOrder unexpected error:', err);
      res.status(500).json({ error: 'Failed to create order' });
    }
  }

  static async getOrder(req, res) {
    try {
      const order = await Order.getByIdWithDetails(
        req.params.orderId,
        req.userRole === 'user'   ? req.userId : null,
        req.userRole === 'driver' ? req.userId : null,
      );

      if (!order) {
        return res.status(404).json({ error: 'Order not found' });
      }

      res.json({ order });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch order' });
    }
  }

  static async getUserOrders(req, res) {
    const page  = Math.max(1, parseInt(req.query.page  || '1'));
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '20')));

    try {
      const orders = await Order.getUserOrders(req.userId, page, limit);
      res.json({ orders, page, limit, hasMore: orders.length === limit });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch orders' });
    }
  }

  static async updateOrderStatus(req, res) {
    const { status } = req.body;
    const io = req.app.get('io');

    try {
      const order = await Order.getByIdWithDetails(req.params.orderId);
      if (!order) {
        return res.status(404).json({ error: 'Order not found' });
      }

      if (order.driver_id !== req.userId) {
        return res.status(403).json({ error: 'Not your order' });
      }

      const updated = await updateOrderStatus(req.params.orderId, status, {
        actorId: req.userId,
        actorRole: 'driver',
        io,
      });

      res.json({ success: true, status: normalizeState(updated.status) });
    } catch (err) {
      res.status(400).json({ error: err.message || 'Failed to update status' });
    }
  }

  static async cancelOrder(req, res) {
    const { orderId } = req.params;

    try {
      const result = await db.query(
        `SELECT * FROM orders WHERE id = $1 AND user_id = $2`,
        [orderId, req.userId],
      );
      if (!result.rows.length) {
        return res.status(404).json({ error: 'Order not found' });
      }

      const order = result.rows[0];
      const state = normalizeState(order.status);

      if (['picked_up', 'in_transit', 'delivered', 'completed'].includes(state)) {
        return res.status(409).json({ error: 'Order cannot be cancelled at this stage' });
      }

      let refundMode = 'none';
      if (['payment_pending', 'paid', 'waiting_for_driver'].includes(state)) {
        refundMode = 'full_refund';
      } else if (state === 'driver_assigned') {
        refundMode = 'store_refund_keep_delivery';
        const deliveryFee = parseFloat(order.delivery_fee || 0);
        const penalty     = Math.round(deliveryFee * 0.25 * 100) / 100;
        if (penalty > 0 && order.payment_method === 'card' && order.payment_status === 'paid') {
          await db.query(
            `INSERT INTO payments (order_id, user_id, amount, method, provider, status, type, metadata)
             VALUES ($1, $2, $3, $4, $5, 'paid', 'penalty', $6::jsonb)`,
            [
              orderId,
              req.userId,
              penalty,
              order.payment_method,
              'paystack',
              JSON.stringify({ reason: 'late_cancellation_penalty', penalty_percent: 25 }),
            ],
          );
          await db.query(
            `UPDATE orders SET cancellation_penalty = $1, updated_at = NOW() WHERE id = $2`,
            [penalty, orderId],
          );
        }
      } else if (state === 'driver_arrived_store') {
        refundMode = 'store_refund_no_delivery_refund';
      }

      // Wallet reversal (if any) and the order-status transition to
      // 'cancelled' now share a single transaction. Previously these were
      // two separate transactions (DriverWallet.transaction(...), then a
      // second independent BEGIN/COMMIT inside updateOrderStatus) — a crash
      // between them could reverse the driver's pending payout while the
      // order stayed in its prior in-flight status, or vice versa.
      const client = await db.connect();
      let cancelledOrder;
      try {
        await client.query('BEGIN');

        if (order.driver_id && ['assigned', 'held'].includes(order.delivery_payment_status || '') && !order.driver_paid) {
          const payout = parseFloat(order.driver_payout || order.delivery_fee || 0);
          if (payout > 0) {
            await DriverWallet.reversePending(client, order.driver_id, payout, order.id, 'customer_cancelled');
          }
        }

        cancelledOrder = await updateOrderStatus(orderId, 'cancelled', {
          actorId: req.userId,
          actorRole: 'user',
          externalClient: client,
        });

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      // Side effects (socket emit, push notification) only fire after the
      // transaction above has actually committed.
      emitOrderUpdate(req.app.get('io'), orderId, cancelledOrder.user_id, cancelledOrder.status);
      await notifyOrderStatusChange(cancelledOrder, 'cancelled');

      await db.query(
        `INSERT INTO order_cancellations (order_id, cancelled_by_id, cancelled_by_role, reason, refund_mode)
         VALUES ($1, $2, 'user', $3, $4)`,
        [orderId, req.userId, req.body?.reason || null, refundMode],
      );

      let refund = null;
      if (
        refundMode === 'full_refund' &&
        order.payment_method === 'card' &&
        order.payment_status === 'paid'
      ) {
        refund = await RefundService.refundOrderPayment(
          orderId,
          req.userId,
          req.body?.reason || 'customer_cancellation',
        );
      }

      const finalOrder = await db.query(
        `SELECT cancellation_penalty FROM orders WHERE id = $1`,
        [orderId],
      );
      return res.json({
        success: true,
        status: 'cancelled',
        refundMode,
        refundStatus:        refund?.status            || null,
        refundReference:     refund?.refund_reference  || null,
        cancellationPenalty: parseFloat(finalOrder.rows[0]?.cancellation_penalty || 0),
      });
    } catch (err) {
      return res.status(400).json({ error: err.message || 'Failed to cancel order' });
    }
  }

  static async requestReturn(req, res) {
    const { orderId } = req.params;
    const { reason }  = req.body;
    const Return = require('../models/Return');

    try {
      const returnRequest = await Return.requestReturn(orderId, req.userId, reason);
      res.status(201).json({ returnRequest });
    } catch (err) {
      if (err.message === 'Order not found')                return res.status(404).json({ error: 'Order not found' });
      if (err.message === 'Can only return delivered orders') return res.status(400).json({ error: err.message });
      if (err.message === 'Return already requested')        return res.status(409).json({ error: err.message });
      res.status(500).json({ error: 'Failed to request return' });
    }
  }

  static async selectDriver(req, res) {
    const { orderId } = req.params;
    const { driverId } = req.body;
    const io = req.app.get('io');

    if (!driverId) {
      return res.status(400).json({ error: 'driverId is required' });
    }

    try {
      const order = await Order.getByIdWithDetails(orderId, req.userId);
      if (!order) {
        return res.status(404).json({ error: 'Order not found' });
      }

      if (normalizeState(order.status) !== 'waiting_for_driver') {
        return res.status(409).json({
          error: 'Order must be waiting for a driver before assignment',
        });
      }

      if (order.driver_id) {
        return res.status(409).json({ error: 'Order already assigned' });
      }

      const driverResult = await Order.query(
        `SELECT id, name, phone, vehicle_type, vehicle_plate, rating,
                total_deliveries, profile_photo_url, is_online, status,
                EXISTS(
                  SELECT 1 FROM orders o2
                  WHERE o2.driver_id = drivers.id
                    AND o2.status IN ('driver_assigned','driver_arrived_store','picked_up','in_transit')
                ) as is_busy
         FROM drivers
         WHERE id = $1`,
        [driverId],
      );

      const driver = driverResult.rows[0];
      if (!driver) {
        return res.status(404).json({ error: 'Driver not found' });
      }
      if (!driver.is_online || driver.status !== 'approved' || driver.is_busy) {
        return res.status(409).json({
          error: 'Selected driver is not currently available',
        });
      }

      await assignDriver(orderId, driverId, { io });

      if (io) {
        io.to(`driver:${driverId}`).emit('new_order_available', {
          orderId,
          isCashDelivery: order.is_cash_delivery,
          preferredAssignment: true,
        });
        io.to(`user:${req.userId}`).emit('order_update', {
          orderId,
          status: 'driver_assigned',
          driver: {
            id:           driver.id,
            name:         driver.name,
            phone:        driver.phone,
            vehicle_type: driver.vehicle_type,
            vehicle_plate: driver.vehicle_plate,
            total_deliveries: driver.total_deliveries,
            profile_photo_url: driver.profile_photo_url,
            rating:       driver.rating,
          },
        });
        io.to(`order:${orderId}`).emit('order_update', {
          orderId,
          status: 'driver_assigned',
          driver: {
            id:           driver.id,
            name:         driver.name,
            phone:        driver.phone,
            vehicle_type: driver.vehicle_type,
            vehicle_plate: driver.vehicle_plate,
            total_deliveries: driver.total_deliveries,
            profile_photo_url: driver.profile_photo_url,
            rating:       driver.rating,
          },
          timestamp: new Date().toISOString(),
        });
      }

      return res.json({
        success: true,
        orderId,
        status: 'driver_assigned',
        driver: {
          id:           driver.id,
          name:         driver.name,
          phone:        driver.phone,
          vehicle_type: driver.vehicle_type,
          vehicle_plate: driver.vehicle_plate,
          total_deliveries: driver.total_deliveries,
          profile_photo_url: driver.profile_photo_url,
          rating:       driver.rating,
        },
      });
    } catch (err) {
      console.error('[Order] Driver selection error:', err.message);
      return res.status(400).json({ error: err.message || 'Failed to assign selected driver' });
    }
  }

  static async rateDriver(req, res) {
    const { orderId } = req.params;
    const { rating, comment } = req.body;

    try {
      const orderResult = await db.query(
        `SELECT driver_id FROM orders WHERE id = $1 AND user_id = $2`,
        [orderId, req.userId],
      );
      if (!orderResult.rows.length) {
        return res.status(404).json({ error: 'Order not found' });
      }
      const driverId = orderResult.rows[0].driver_id;
      if (!driverId) {
        return res.status(400).json({ error: 'This order has no assigned driver to rate' });
      }

      const result = await Rating.submitRating(orderId, req.userId, driverId, rating, comment);
      return res.status(201).json({ success: true, ...result });
    } catch (err) {
      return res.status(400).json({ error: err.message || 'Failed to submit rating' });
    }
  }
}

module.exports = OrderController;