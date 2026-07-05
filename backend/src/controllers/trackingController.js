const Tracking = require("../models/Tracking");

class TrackingController {
  static async getOrderLocation(req, res) {
    const { orderId } = req.params;
    try {
      const location = await Tracking.getOrderLocation(
        orderId,
        req.userId,
        req.userRole,
      );
      if (!location) {
        return res.status(404).json({ error: "Order not found or access denied" });
      }
      res.json(location);
    } catch (err) {
      console.error("[Tracking] getOrderLocation error:", err.message);
      res.status(500).json({ error: "Failed to fetch location" });
    }
  }
}

module.exports = TrackingController;
