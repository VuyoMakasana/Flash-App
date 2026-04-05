const Order = require("../models/Order");
const db = require("../config/database");
const DriverWallet = require("../models/DriverWallet");
const {
  updateOrderStatus,
  assignDriver,
  normalizeState,
} = require("../services/orderStateMachineService");
const RefundService = require("../services/refundService");

class OrderController {
  static async createOrder(req, res) {
    const {
      items,
      delivery_mode,
      time_slot,
      subtotal,
      store_id,
      // Accept both field names — frontend sends requested_driver_id,
      // database column is preferred_driver_id. Merge here so both work.
      preferred_driver_id,
      requested_driver_id,
      pickup_mall_id,
      dropoff_mall_id,
      pickup_address,
      dropoff_address,
      pickup_lat,
      pickup_lng,
      dropoff_lat,
      dropoff_lng,
    } = req.body;

    if (!items?.length) {
      return res.status(400).json({ error: "Order must have items" });
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
        pickup_lat,
        pickup_lng,
        dropoff_lat,
        dropoff_lng,
      });

      res.status(201).json({ order, orderNumber: order.order_number });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to create order" });
    }
  }

  static async getOrder(req, res) {
    try {
      const order = await Order.getByIdWithDetails(
        req.params.orderId,
        req.userRole === "user" ? req.userId : null,
        req.userRole === "driver" ? req.userId : null,
      );

      if (!order) {
        return res.status(404).json({ error: "Order not found" });
      }

      res.json({ order });
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch order" });
    }
  }

  static async getUserOrders(req, res) {
    const page = Math.max(1, parseInt(req.query.page || "1"));
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || "20")));

    try {
      const orders = await Order.getUserOrders(req.userId, page, limit);
      res.json({ orders, page, limit, hasMore: orders.length === limit });
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch orders" });
    }
  }

  static async updateOrderStatus(req, res) {
    const { status } = req.body;
    const io = req.app.get("io");

    try {
      const order = await Order.getByIdWithDetails(req.params.orderId);
      if (!order) {
        return res.status(404).json({ error: "Order not found" });
      }

      if (order.driver_id !== req.userId) {
        return res.status(403).json({ error: "Not your order" });
      }

      const updated = await updateOrderStatus(req.params.orderId, status, {
        actorId: req.userId,
        actorRole: "driver",
        io,
      });

      res.json({ success: true, status: normalizeState(updated.status) });
    } catch (err) {
      res.status(400).json({ error: err.message || "Failed to update status" });
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
        return res.status(404).json({ error: "Order not found" });
      }

      const order = result.rows[0];
      const state = normalizeState(order.status);

      if (["picked_up", "in_transit", "delivered", "completed"].includes(state)) {
        return res.status(409).json({ error: "Order cannot be cancelled at this stage" });
      }

      let refundMode = "none";
      if (["payment_pending", "paid", "waiting_for_driver"].includes(state)) {
        refundMode = "full_refund";
      } else if (state === "driver_assigned") {
        refundMode = "store_refund_keep_delivery";
      } else if (state === "driver_arrived_store") {
        refundMode = "store_refund_no_delivery_refund";
      }

      if (order.driver_id && ["assigned", "held"].includes(order.delivery_payment_status || "") && !order.driver_paid) {
        await DriverWallet.transaction(async (client) => {
          const payout = parseFloat(order.driver_payout || order.delivery_fee || 0);
          if (payout > 0) {
            await DriverWallet.reversePending(client, order.driver_id, payout, order.id, "customer_cancelled");
          }
        });
      }

      await updateOrderStatus(orderId, "cancelled", {
        actorId: req.userId,
        actorRole: "user",
        io: req.app.get("io"),
      });

      await db.query(
        `INSERT INTO order_cancellations (order_id, cancelled_by_id, cancelled_by_role, reason, refund_mode)
         VALUES ($1, $2, 'user', $3, $4)`,
        [orderId, req.userId, req.body?.reason || null, refundMode],
      );

      let refund = null;
      if (
        refundMode === "full_refund" &&
        ["card", "payflex"].includes(order.payment_method) &&
        order.payment_status === "paid"
      ) {
        refund = await RefundService.refundOrderPayment(
          orderId,
          req.userId,
          req.body?.reason || "customer_cancellation",
        );
      }

      return res.json({
        success: true,
        status: "cancelled",
        refundMode,
        refundStatus: refund?.status || null,
        refundReference: refund?.refund_reference || null,
      });
    } catch (err) {
      return res.status(400).json({ error: err.message || "Failed to cancel order" });
    }
  }

  static async requestReturn(req, res) {
    const { orderId } = req.params;
    const { reason } = req.body;
    const Return = require("../models/Return");

    try {
      const returnRequest = await Return.requestReturn(
        orderId,
        req.userId,
        reason,
      );
      res.status(201).json({ returnRequest });
    } catch (err) {
      if (err.message === "Order not found") {
        return res.status(404).json({ error: "Order not found" });
      }
      if (err.message === "Can only return delivered orders") {
        return res.status(400).json({ error: err.message });
      }
      if (err.message === "Return already requested") {
        return res.status(409).json({ error: err.message });
      }
      res.status(500).json({ error: "Failed to request return" });
    }
  }

  static async selectDriver(req, res) {
    const { orderId } = req.params;
    const { driverId } = req.body;
    const io = req.app.get("io");

    if (!driverId) {
      return res.status(400).json({ error: "driverId is required" });
    }

    try {
      const order = await Order.getByIdWithDetails(orderId, req.userId);
      if (!order) {
        return res.status(404).json({ error: "Order not found" });
      }

      if (normalizeState(order.status) !== "waiting_for_driver") {
        return res.status(409).json({
          error: "Order must be waiting for a driver before assignment",
        });
      }

      if (order.driver_id) {
        return res.status(409).json({ error: "Order already assigned" });
      }

      const driverResult = await Order.query(
        `SELECT id, name, phone, vehicle_type, rating, is_online, status,
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
        return res.status(404).json({ error: "Driver not found" });
      }
      if (!driver.is_online || driver.status !== "approved" || driver.is_busy) {
        return res.status(409).json({
          error: "Selected driver is not currently available",
        });
      }

      await assignDriver(orderId, driverId, { io });

      if (io) {
        io.to(`driver:${driverId}`).emit("new_order_available", {
          orderId,
          isCashDelivery: order.is_cash_delivery,
          preferredAssignment: true,
        });
        io.to(`user:${req.userId}`).emit("order_update", {
          orderId,
          status: "driver_assigned",
          driver: {
            id: driver.id,
            name: driver.name,
            phone: driver.phone,
            vehicle_type: driver.vehicle_type,
            rating: driver.rating,
          },
        });
        io.to(`order:${orderId}`).emit("order_update", {
          orderId,
          status: "driver_assigned",
          driver: {
            id: driver.id,
            name: driver.name,
            phone: driver.phone,
            vehicle_type: driver.vehicle_type,
            rating: driver.rating,
          },
          timestamp: new Date().toISOString(),
        });
      }

      return res.json({
        success: true,
        orderId,
        status: "driver_assigned",
        driver: {
          id: driver.id,
          name: driver.name,
          phone: driver.phone,
          vehicle_type: driver.vehicle_type,
          rating: driver.rating,
        },
      });
    } catch (err) {
      console.error("[Order] Driver selection error:", err.message);
      return res.status(400).json({ error: err.message || "Failed to assign selected driver" });
    }
  }
}

module.exports = OrderController;
