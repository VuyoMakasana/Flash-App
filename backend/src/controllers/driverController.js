const Driver = require("../models/Driver");
const Order = require("../models/Order");
const {
  checkDriverSubscriptionAllowed,
} = require("../services/subscriptionService");

class DriverController {
  static async getProfile(req, res) {
    try {
      const driver = await Driver.findById(req.userId, "drivers");
      if (!driver) {
        return res.status(404).json({ error: "Driver not found" });
      }

      const { password_hash, ...safeDriver } = driver;

      // Get document upload status
      const docs = await Driver.getDocuments(req.userId);

      res.json({ driver: safeDriver, documents: docs });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to fetch profile" });
    }
  }

  static async updateProfile(req, res) {
    const { name, phone, vehicle_type, vehicle_plate } = req.body;
    try {
      const driver = await Driver.updateProfile(req.userId, {
        name,
        phone,
        vehicle_type,
        vehicle_plate,
      });
      const { password_hash, ...safeDriver } = driver;
      res.json({ driver: safeDriver });
    } catch (err) {
      res.status(500).json({ error: "Failed to update profile" });
    }
  }

  static async uploadDocument(req, res) {
    const { document_type } = req.body;
    const REQUIRED_DOCS = [
      "government_id",
      "drivers_license",
      "police_certified",
      "profile_photo",
      "vehicle_registration",
    ];

    if (!REQUIRED_DOCS.includes(document_type)) {
      return res
        .status(400)
        .json({
          error: `Invalid document type. Must be one of: ${REQUIRED_DOCS.join(", ")}`,
        });
    }

    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    try {
      const result = await Driver.uploadDocument(
        req.userId,
        document_type,
        req.file,
      );
      res.json(result);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Upload failed" });
    }
  }

  static async setOnlineStatus(req, res) {
    const { online } = req.body;
    try {
      await Driver.setOnlineStatus(req.userId, online);
      res.json({ online: !!online });
    } catch (err) {
      res.status(500).json({ error: "Failed to update status" });
    }
  }

  static async updateLocation(req, res) {
    const { lat, lng, orderId } = req.body;
    const io = req.app.get("io");

    if (!lat || !lng) {
      return res.status(400).json({ error: "lat and lng required" });
    }

    try {
      await Driver.updateLocation(req.userId, lat, lng, orderId, io);
      res.json({ success: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to update location" });
    }
  }

  static async getAvailableOrders(req, res) {
    try {
      const subCheck = await checkDriverSubscriptionAllowed(req.userId);
      if (!subCheck.allowed) {
        return res
          .status(403)
          .json({ error: subCheck.reason, requiresSubscription: true });
      }

      const orders = await Driver.getAvailableOrders(req.userId);
      res.json({ orders });
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch orders" });
    }
  }

  static async acceptOrder(req, res) {
    const { orderId } = req.params;
    const io = req.app.get("io");

    try {
      const order = await Driver.acceptOrder(req.userId, orderId);
      if (!order) {
        return res
          .status(409)
          .json({ error: "Order already taken or unavailable" });
      }

      if (io) {
        io.to(`order:${orderId}`).emit("order_update", {
          orderId,
          status: "driver_assigned",
          driverId: req.userId,
        });
      }

      res.json({ order });
    } catch (err) {
      res.status(500).json({ error: "Failed to accept order" });
    }
  }

  static async getEarnings(req, res) {
    try {
      const earnings = await Driver.getEarnings(req.userId);
      res.json(earnings);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch earnings" });
    }
  }

  static async getActiveOrder(req, res) {
    try {
      const order = await Driver.getActiveOrder(req.userId);
      res.json({ order });
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch active order" });
    }
  }

  static async getNearbyDrivers(req, res) {
    const { lat, lng } = req.query;
    try {
      const drivers = await Driver.getNearby(lat, lng);
      res.json({ drivers });
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch nearby drivers" });
    }
  }
}

module.exports = DriverController;
