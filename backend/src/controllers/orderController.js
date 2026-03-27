const Order = require("../models/Order");

class OrderController {
  static async createOrder(req, res) {
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

    if (!items?.length) {
      return res.status(400).json({ error: "Order must have items" });
    }

    try {
      const order = await Order.create({
        userId: req.userId,
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

    const validTransitions = {
      driver_assigned: ["en_route"],
      en_route: ["picked_up"],
      picked_up: ["delivered"],
      delivered: ["completed"],
    };

    try {
      const order = await Order.getByIdWithDetails(req.params.orderId);
      if (!order) {
        return res.status(404).json({ error: "Order not found" });
      }

      if (order.driver_id !== req.userId) {
        return res.status(403).json({ error: "Not your order" });
      }

      const allowedNext = validTransitions[order.status] || [];
      if (!allowedNext.includes(status)) {
        return res.status(400).json({
          error: `Cannot transition from ${order.status} to ${status}`,
        });
      }

      await Order.updateStatus(req.params.orderId, status);

      if (io) {
        io.to(`order:${req.params.orderId}`).emit("order_update", {
          orderId: req.params.orderId,
          status,
          timestamp: new Date().toISOString(),
        });
        io.to(`user:${order.user_id}`).emit("order_update", {
          orderId: req.params.orderId,
          status,
        });
      }

      res.json({ success: true, status });
    } catch (err) {
      res.status(500).json({ error: "Failed to update status" });
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

      if (order.status !== "paid") {
        return res.status(409).json({
          error: "Order must be paid before selecting a driver",
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
                    AND o2.status IN ('driver_assigned','en_route','picked_up')
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

      const assigned = await Order.query(
        `UPDATE orders
         SET driver_id = $1, status = 'driver_assigned', updated_at = NOW()
         WHERE id = $2 AND user_id = $3 AND status = 'paid' AND driver_id IS NULL
         RETURNING id, order_number, user_id, driver_id, status`,
        [driverId, orderId, req.userId],
      );

      if (!assigned.rows.length) {
        return res
          .status(409)
          .json({ error: "Driver assignment failed. Please try again." });
      }

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
      return res.status(500).json({ error: "Failed to assign selected driver" });
    }
  }
}

module.exports = OrderController;
