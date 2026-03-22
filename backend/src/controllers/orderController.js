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
}

module.exports = OrderController;
