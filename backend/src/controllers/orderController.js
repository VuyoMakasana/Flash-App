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
const s3Service = require('../services/s3Service');
const { isWithinNelsonMandelaBay, OUTSIDE_SERVICE_AREA_MESSAGE, FLASH_STORE_LOCATION } = require('../utils/geoBoundary');

// Errors thrown by validateExternalItemPrice() and inventory stock checks
// contain one of these fragments. Treat them as client errors (400) rather
// than server errors (500).
//
// BUG FIX: the out-of-stock message is `${itemName} size ${size} is out of
// stock` (Order.js) — the item name comes BEFORE "is out of stock", so this
// message never actually starts with it. With .startsWith(), every real
// out-of-stock order create returned a generic 500 instead of a clean 400,
// confirmed live. The other four entries are either true prefixes or exact
// messages with no dynamic content before them, so switching the whole
// check to .includes() fixes this one case without changing behavior for
// the rest (a substring match and a startsWith match are identical for a
// string with nothing dynamic in front of it).
const CLIENT_ERROR_FRAGMENTS = [
  'Invalid price for',
  'Invalid quantity for',
  'is out of stock',
  'Order must have items',
  'Order total must be positive',
];

function isClientError(message) {
  if (!message) return false;
  return CLIENT_ERROR_FRAGMENTS.some((fragment) => message.includes(fragment));
}

// Pre-pickup, post-assignment cancellation split — confirmed with the
// founder (not guessed): 10% of item value to the store, 5% to the assigned
// driver as compensation for the trip already started, the remainder (85%)
// plus the FULL delivery fee back to the customer. The remainder is computed
// as itemValue minus the two shares rather than an independent multiplication
// so the three shares always add up to exactly itemValue, with no rounding
// gap.
//
// A second, harsher-for-the-store tier applies once the driver has actually
// arrived at the store (driver_arrived_store) — also confirmed with the
// founder: 0% to the store (nothing left the premises), 8% to the driver
// (higher than the pre-arrival 5%, since they've made the actual trip), 92%
// of item value plus the full delivery fee back to the customer. Same
// remainder-based math, different percentages passed in by the caller.
//
// Cash orders haven't collected any payment yet (that happens at delivery),
// so there is nothing to withhold from the store or refund to the customer —
// only the driver's share is real there, paid directly by Flash as
// compensation for the wasted trip. Shared by cancelOrder and its own
// read-only preview endpoint so the two can never drift apart on the math.
function computeCancellationSplit(order, { storePct = 0.10, driverPct = 0.05 } = {}) {
  const itemValue    = parseFloat(order.subtotal) || 0;
  const deliveryFee  = parseFloat(order.delivery_fee) || 0;
  const isCash       = order.payment_method === 'cash';

  const storeAmount        = isCash ? 0 : Math.round(itemValue * storePct * 100) / 100;
  const driverAmount       = Math.round(itemValue * driverPct * 100) / 100;
  const customerItemRefund = isCash ? 0 : Math.round((itemValue - storeAmount - driverAmount) * 100) / 100;
  const deliveryFeeRefund  = isCash ? 0 : deliveryFee;

  return {
    itemValue,
    deliveryFee,
    isCash,
    storeAmount,
    driverAmount,
    customerItemRefund,
    deliveryFeeRefund,
    totalCustomerRefund: customerItemRefund + deliveryFeeRefund,
  };
}

class OrderController {
  static async createOrder(req, res) {
    const {
      items,
      delivery_mode,
      time_slot,
      subtotal,
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
        // Not client-supplied, same trust boundary as pickup_lat/pickup_lng
        // just below -- there is no multi-vendor "stores" concept yet, so a
        // client-sent store_id has nothing real to validate against. Was
        // previously passed straight through from req.body with zero
        // validation; harmless while orders.store_id was free-text VARCHAR
        // and no real client ever populated it, but store_id is now a real
        // UUID column (migration v27) -- an arbitrary client string would
        // 500 the whole order-creation request instead of silently doing
        // nothing. Explicit null until a real stores table + checkout
        // store-selection step exists.
        store_id: null,
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

  // Package protection: pickup/drop-off photos are never returned as
  // permanent URLs — only public_id/resource_type are ever stored (see
  // driverController.submitPickupPhoto/submitDropoffPhoto), and a
  // short-lived signed URL is generated here on demand, same pattern
  // Admin.getDriverById already uses for driver documents.
  static async getOrderPhotos(req, res) {
    try {
      const result = await db.query(
        `SELECT user_id, driver_id,
                pickup_photo_public_id, pickup_photo_resource_type, pickup_photo_at,
                dropoff_photo_public_id, dropoff_photo_resource_type, dropoff_photo_at
         FROM orders WHERE id = $1`,
        [req.params.orderId],
      );
      if (!result.rows.length) return res.status(404).json({ error: 'Order not found' });

      const order = result.rows[0];
      // ADMIN-ACCESS FIX (ADMIN_PANEL_AUDIT_AND_VISION.md, Addendum 3 §2):
      // neither guard below ever matched req.userRole === 'admin', so an
      // admin token previously passed straight through by omission -- never
      // denied, but never a deliberate decision either, the same class of
      // gap already found and closed once this engagement for the
      // unauthenticated /api/drivers/nearby endpoint. Rewritten as an
      // explicit allow-list: exactly three cases are allowed (the order's
      // own customer, its own driver, or any admin) and everything else is
      // denied on purpose, rather than "whatever isn't user-or-driver falls
      // through unchecked."
      const isOwnCustomer = req.userRole === 'user' && order.user_id === req.userId;
      const isOwnDriver = req.userRole === 'driver' && order.driver_id === req.userId;
      const isAdmin = req.userRole === 'admin';
      if (!isOwnCustomer && !isOwnDriver && !isAdmin) {
        return res.status(403).json({ error: 'Not your order' });
      }

      const [pickupPhotoUrl, dropoffPhotoUrl] = await Promise.all([
        order.pickup_photo_public_id
          ? s3Service.getSignedUrl(order.pickup_photo_public_id, order.pickup_photo_resource_type || 'image')
          : null,
        order.dropoff_photo_public_id
          ? s3Service.getSignedUrl(order.dropoff_photo_public_id, order.dropoff_photo_resource_type || 'image')
          : null,
      ]);

      res.json({
        pickupPhotoUrl,
        pickupPhotoAt:  order.pickup_photo_at,
        dropoffPhotoUrl,
        dropoffPhotoAt: order.dropoff_photo_at,
      });
    } catch (err) {
      console.error('[Order] getOrderPhotos error:', err.message);
      res.status(500).json({ error: 'Failed to fetch order photos' });
    }
  }

  // Read-only — computes the exact split cancelOrder would apply, without
  // changing anything, so the customer sees real numbers before confirming.
  static async getCancellationPreview(req, res) {
    try {
      const result = await db.query(
        `SELECT * FROM orders WHERE id = $1 AND user_id = $2`,
        [req.params.orderId, req.userId],
      );
      if (!result.rows.length) return res.status(404).json({ error: 'Order not found' });

      const order = result.rows[0];
      const state = normalizeState(order.status);

      if (['picked_up', 'in_transit', 'delivered', 'completed', 'cancelled'].includes(state)) {
        return res.status(409).json({ error: 'Order cannot be cancelled at this stage' });
      }

      if (!order.driver_id) {
        return res.json({ hasDriverAssigned: false, fullRefund: true });
      }

      const arrivedAtStore = state === 'driver_arrived_store';
      const split = computeCancellationSplit(
        order,
        arrivedAtStore ? { storePct: 0, driverPct: 0.08 } : undefined,
      );
      return res.json({ hasDriverAssigned: true, fullRefund: false, stage: state, ...split });
    } catch (err) {
      console.error('[Order] getCancellationPreview error:', err.message);
      res.status(500).json({ error: 'Failed to compute cancellation preview' });
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

      // PACKAGE PROTECTION FIX: a driver could reach 'completed' directly
      // through this generic endpoint, bypassing the OTP-based delivery
      // confirmation entirely for card orders — confirmed live, this exact
      // bypass worked before this fix. Cash orders already had their own
      // block for this (updateOrderStatus's 'completed' branch throws
      // unless payment_status is already 'paid'), but nothing equivalent
      // existed for card. Reverse-delivery return orders are excluded —
      // they're dropped off at Flash's own store, not a customer, so there
      // is no OTP participant on the receiving end and this is still their
      // only legitimate way to complete.
      if (normalizeState(status) === 'completed' && !order.is_return_order) {
        return res.status(409).json({
          error: 'Use the delivery confirmation OTP to complete this order.',
        });
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

      // Pre-pickup cancellation split — confirmed formula (see
      // computeCancellationSplit above): 10% of item value to the store,
      // 5% to the assigned driver, the remainder + full delivery fee back
      // to the customer. Replaces the old 25%-of-delivery-fee penalty,
      // which never actually issued a real refund for card orders — it
      // only recorded a penalty amount nothing ever deducted from.
      //
      // driver_arrived_store gets its own, harsher-for-the-store tier
      // (0%/8%/92%, see computeCancellationSplit) rather than reusing
      // driver_assigned's numbers. This mode was previously named
      // 'store_refund_no_delivery_refund' (32 chars) which exceeded
      // order_cancellations.refund_mode's VARCHAR(30) and made every
      // cancellation attempt at this stage throw and roll back with a bare
      // 400 -- the customer could not cancel at all once the driver had
      // arrived at the store. Renamed to fit, and given a real split and
      // refund branch (see below) instead of silently refunding nothing.
      // pending_store_acceptance/preparing added alongside the existing
      // three: a customer cancelling before or during store preparation
      // has no driver assigned yet either, same as waiting_for_driver --
      // full refund is correct here for the same reason, not something
      // these two new states get by accident. Found and fixed before ever
      // shipping the new states: without this, a cancellation attempt
      // during either would have fallen through every branch below
      // (refundMode staying 'none'), silently refunding nothing.
      let refundMode = 'none';
      let split = null;
      if (['payment_pending', 'paid', 'pending_store_acceptance', 'preparing', 'waiting_for_driver'].includes(state)) {
        refundMode = 'full_refund';
      } else if (state === 'driver_assigned') {
        refundMode = 'pre_pickup_split';
        split = computeCancellationSplit(order);
      } else if (state === 'driver_arrived_store') {
        refundMode = 'store_arrival_split';
        split = computeCancellationSplit(order, { storePct: 0, driverPct: 0.08 });
      }

      // Wallet reversal, the driver's split compensation (if any), the
      // order_cancellations record, and the order-status transition to
      // 'cancelled' all share a single transaction — a crash partway
      // through must never leave the driver compensated without a record
      // of why, or the order cancelled without the compensation it implies.
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

        if (split && order.driver_id && split.driverAmount > 0) {
          await DriverWallet.creditAvailable(
            client, order.driver_id, split.driverAmount, order.id,
            refundMode === 'store_arrival_split'
              ? 'store_arrival_cancellation_compensation'
              : 'pre_pickup_cancellation_compensation',
          );
        }

        cancelledOrder = await updateOrderStatus(orderId, 'cancelled', {
          actorId: req.userId,
          actorRole: 'user',
          externalClient: client,
        });

        const cancellationRow = await client.query(
          `INSERT INTO order_cancellations (
             order_id, cancelled_by_id, cancelled_by_role, reason, refund_mode,
             item_value_at_cancellation, store_amount, driver_amount, customer_item_refund, delivery_fee_refunded
           ) VALUES ($1, $2, 'user', $3, $4, $5, $6, $7, $8, $9)
           RETURNING id`,
          [
            orderId,
            req.userId,
            req.body?.reason || null,
            refundMode,
            split?.itemValue          || 0,
            split?.storeAmount        || 0,
            split?.driverAmount       || 0,
            split?.customerItemRefund || 0,
            split?.deliveryFeeRefund  || 0,
          ],
        );

        if (split && split.storeAmount > 0) {
          await client.query(
            `INSERT INTO order_cancellation_store_shares (order_cancellation_id, store_id, amount)
             VALUES ($1, $2, $3)`,
            [cancellationRow.rows[0].id, order.store_id || null, split.storeAmount],
          );
        }

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      // Side effects (socket emit, push notification, and the actual
      // payment-provider refund call) only fire after the transaction
      // above has actually committed.
      emitOrderUpdate(req.app.get('io'), orderId, cancelledOrder.user_id, cancelledOrder.status);
      await notifyOrderStatusChange(cancelledOrder, 'cancelled');

      // CRITICAL FIX: the cancellation itself (status, wallet credit, split
      // record) has already committed by this point — a failure submitting
      // the refund to Paystack (e.g. locally with no PAYSTACK_SECRET_KEY
      // configured, confirmed live) must not make the response look like
      // the whole cancellation failed. It didn't: the order is genuinely
      // cancelled and the driver genuinely compensated regardless of
      // whether the refund submission itself succeeds. This wraps only the
      // refund attempt so its failure surfaces as a degraded but still-
      // successful response, not a 400 that contradicts what the database
      // already committed. Pre-existing gap, not unique to the new split
      // path — 'full_refund' had the exact same unguarded call before this.
      let refund = null;
      let refundError = null;
      const isCardPaid = order.payment_method === 'card' && order.payment_status === 'paid';
      try {
        if (refundMode === 'full_refund' && isCardPaid) {
          refund = await RefundService.refundOrderPayment(
            orderId,
            req.userId,
            req.body?.reason || 'customer_cancellation',
          );
        } else if (
          (refundMode === 'pre_pickup_split' || refundMode === 'store_arrival_split')
          && isCardPaid && split.totalCustomerRefund > 0
        ) {
          refund = await RefundService.refundOrderPayment(
            orderId,
            req.userId,
            req.body?.reason || 'customer_cancellation',
            split.totalCustomerRefund,
          );
        }
      } catch (err) {
        console.error('[Order] cancelOrder refund submission failed (order already cancelled):', err.message);
        refundError = err.message;
      }

      return res.json({
        success: true,
        status: 'cancelled',
        refundMode,
        refundStatus:    refund?.status           || null,
        refundReference: refund?.refund_reference || null,
        refundError,
        split,
      });
    } catch (err) {
      return res.status(400).json({ error: err.message || 'Failed to cancel order' });
    }
  }

  static async requestReturn(req, res) {
    const { orderId } = req.params;
    const { items, reason } = req.body;
    const io = req.app.get('io');
    const Return = require('../models/Return');

    try {
      const returnRequest = await Return.requestReturn(orderId, req.userId, items, reason, io);
      res.status(201).json({ returnRequest });
    } catch (err) {
      const clientErrors = [
        'Order not found',
        'Not your order',
        'Can only return delivered orders',
        'Return eligibility cannot be verified for this order',
        'At least one item must be selected for return',
        'One or more selected items do not belong to this order',
        'Quantity returned must be a positive whole number',
        'Cannot return more than the originally purchased quantity',
      ];
      // Startswith, not an exact string in the array above — this message
      // embeds ELIGIBILITY_WINDOW_HOURS (Return.js), so an exact match would
      // silently break again if that constant ever changes.
      if (clientErrors.includes(err.message) || err.message.startsWith('Returns open')) {
        return res.status(400).json({ error: err.message });
      }
      if (err.message === 'Return already requested') {
        return res.status(409).json({ error: err.message });
      }
      if (err.message.startsWith('Selected items must total at least')) {
        return res.status(400).json({ error: err.message });
      }
      console.error('[Order] requestReturn error:', err.message);
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