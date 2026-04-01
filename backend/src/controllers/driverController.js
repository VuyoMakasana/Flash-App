const Driver = require("../models/Driver");
const Order = require("../models/Order");
const {
  checkDriverSubscriptionAllowed,
} = require("../services/subscriptionService");
const DriverWallet = require("../models/DriverWallet");
const db = require("../config/database");
const {
  assignDriver,
  normalizeState,
} = require("../services/orderStateMachineService");
const { autoAssignNearestDriver } = require("../services/fleetIntelligenceService");

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
      const order = await assignDriver(orderId, req.userId, { io });

      if (io) {
        io.to(`order:${orderId}`).emit("order_update", {
          orderId,
          status: "driver_assigned",
          driverId: req.userId,
        });
      }

      res.json({ order });
    } catch (err) {
      res.status(400).json({ error: err.message || "Failed to accept order" });
    }
  }

  static async cancelAssignedOrder(req, res) {
    const { orderId } = req.params;
    const io = req.app.get("io");

    try {
      const result = await db.query(
        `SELECT * FROM orders WHERE id = $1`,
        [orderId],
      );

      if (!result.rows.length) {
        return res.status(404).json({ error: "Order not found" });
      }

      const order = result.rows[0];
      if (String(order.driver_id) !== String(req.userId)) {
        return res.status(403).json({ error: "Not your order" });
      }

      const state = normalizeState(order.status);
      if (["picked_up", "in_transit", "delivered", "completed"].includes(state)) {
        return res.status(409).json({ error: "Cannot cancel after pickup without admin override" });
      }

      await db.query(
        `UPDATE orders
         SET driver_id = NULL,
             status = 'waiting_for_driver',
             delivery_payment_status = 'pending_driver',
             updated_at = NOW()
         WHERE id = $1`,
        [orderId],
      );

      await db.query(
        `UPDATE drivers SET cancel_count = COALESCE(cancel_count, 0) + 1, updated_at = NOW() WHERE id = $1`,
        [req.userId],
      );

      const payout = parseFloat(order.driver_payout || order.delivery_fee || 0);
      await DriverWallet.transaction(async (client) => {
        if (payout > 0) {
          await DriverWallet.reversePending(client, req.userId, payout, orderId, "driver_cancel_before_pickup");
        }
        await client.query(
          `INSERT INTO driver_penalties (driver_id, order_id, amount, reason)
           VALUES ($1, $2, $3, $4)`,
          [req.userId, orderId, 20, "driver_cancelled_before_pickup"],
        );
      });

      if (io) {
        io.to("driver_pool").emit("new_order_available", { orderId, reassigned: true });
      }

      // Keep fleet orders moving by attempting immediate reassignment.
      await autoAssignNearestDriver(orderId, io).catch(() => null);

      return res.json({ success: true, status: "waiting_for_driver", penaltyApplied: 20 });
    } catch (err) {
      return res.status(400).json({ error: err.message || "Failed to cancel assignment" });
    }
  }

  static async getEarnings(req, res) {
    try {
      const earnings = await Driver.getEarnings(req.userId);
      const wallet = await DriverWallet.getWallet(req.userId);
      res.json({ ...earnings, wallet });
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch earnings" });
    }
  }

  static async getWallet(req, res) {
    try {
      const wallet = await DriverWallet.getWallet(req.userId);
      res.json({ wallet });
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch wallet" });
    }
  }

  static async requestPayout(req, res) {
    const { amount } = req.body;
    try {
      const request = await DriverWallet.createPayoutRequest(req.userId, amount);
      res.status(201).json({ payoutRequest: request });
    } catch (err) {
      res.status(400).json({ error: err.message || "Failed to request payout" });
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
