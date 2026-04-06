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
  requeueOrderForDriverSearch,
} = require("../services/orderStateMachineService");
const { autoAssignNearestDriver } = require("../services/fleetIntelligenceService");
const PayoutService = require("../services/payoutService");
const paystackService = require("../services/paystackService");
const { saveDriverPushToken } = require("../services/notificationService");

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
      // Read-only preflight check (no lock needed yet).
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

      const payout = parseFloat(order.driver_payout || order.delivery_fee || 0);

      // All mutations in a single transaction so that a failure in any step
      // leaves the DB in a consistent state (order remains assigned, wallet
      // pending balance unchanged, no partial penalty row).
      await DriverWallet.transaction(async (client) => {
        await client.query(
          `UPDATE drivers SET cancel_count = COALESCE(cancel_count, 0) + 1, updated_at = NOW() WHERE id = $1`,
          [req.userId],
        );

        if (payout > 0) {
          await DriverWallet.reversePending(client, req.userId, payout, orderId, "driver_cancel_before_pickup");
        }

        await client.query(
          `INSERT INTO driver_penalties (driver_id, order_id, amount, reason)
           VALUES ($1, $2, $3, $4)`,
          [req.userId, orderId, 20, "driver_cancelled_before_pickup"],
        );
      });

      await requeueOrderForDriverSearch(orderId, {
        actorId: req.userId,
        actorRole: "driver",
        io,
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
      const payout = await PayoutService.processRequestedPayout(request.id);
      res.status(201).json({ payoutRequest: request, payout });
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

  // ── Bank Account / Payout Methods ──────────────────────────────────────────

  // Returns the list of supported banks from Paystack (used in the driver app's
  // bank account setup screen so they can pick their bank from a dropdown).
  static async getSupportedBanks(req, res) {
    try {
      const result = await paystackService.getBankList();
      if (!result.status) {
        return res.status(502).json({ error: "Could not fetch bank list" });
      }
      res.json({ banks: result.data || [] });
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch bank list" });
    }
  }

  // Verifies account number + bank code with Paystack and returns the
  // account_name so the driver can confirm it's theirs before saving.
  static async verifyBankAccount(req, res) {
    const { account_number, bank_code } = req.body;
    if (!account_number || !bank_code) {
      return res.status(400).json({ error: "account_number and bank_code are required" });
    }
    try {
      const result = await paystackService.verifyBankAccount(account_number, bank_code);
      if (!result.status) {
        return res.status(400).json({ error: result.message || "Could not verify account" });
      }
      res.json({ account_name: result.data?.account_name, account_number: result.data?.account_number });
    } catch (err) {
      res.status(500).json({ error: "Bank account verification failed" });
    }
  }

  // Saves a bank account as a Paystack transfer recipient.
  // Called after the driver confirms their account name is correct.
  static async saveBankAccount(req, res) {
    const { account_number, bank_code, account_name } = req.body;
    if (!account_number || !bank_code || !account_name) {
      return res.status(400).json({ error: "account_number, bank_code, and account_name are required" });
    }

    try {
      // Create recipient on Paystack side.
      const recipientRes = await paystackService.createTransferRecipient({
        name: account_name,
        accountNumber: account_number,
        bankCode: bank_code,
        description: `Flash driver – ${req.userId}`,
      });

      if (!recipientRes.status) {
        return res.status(400).json({ error: recipientRes.message || "Failed to register bank account" });
      }

      const recipientCode = recipientRes.data?.recipient_code;
      if (!recipientCode) {
        return res.status(502).json({ error: "Invalid response from payment provider" });
      }

      // Deactivate any existing recipients for this driver, then insert the new one.
      await db.query(
        `UPDATE transfer_recipients SET is_active = false, updated_at = NOW()
         WHERE driver_id = $1`,
        [req.userId],
      );

      await db.query(
        `INSERT INTO transfer_recipients
           (driver_id, recipient_code, account_number, bank_code, account_name, is_active)
         VALUES ($1, $2, $3, $4, $5, true)
         ON CONFLICT (driver_id, account_number, bank_code)
         DO UPDATE SET recipient_code = $2, is_active = true, updated_at = NOW()`,
        [req.userId, recipientCode, account_number, bank_code, account_name],
      );

      res.status(201).json({ success: true, recipient_code: recipientCode, account_name });
    } catch (err) {
      console.error("[BankAccount] Save error:", err.message);
      res.status(500).json({ error: "Failed to save bank account" });
    }
  }

  // Returns the driver's currently registered bank account (masked).
  static async getBankAccount(req, res) {
    try {
      const result = await db.query(
        `SELECT account_name, bank_code,
                CONCAT(REPEAT('*', LENGTH(account_number) - 4), RIGHT(account_number, 4)) AS masked_account_number
         FROM transfer_recipients
         WHERE driver_id = $1 AND is_active = true
         ORDER BY created_at DESC LIMIT 1`,
        [req.userId],
      );
      if (!result.rows.length) {
        return res.json({ bank_account: null });
      }
      res.json({ bank_account: result.rows[0] });
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch bank account" });
    }
  }

  // FIX 6: Saves driver push token to DB — required so backend can send push notifications when new orders arrive
  static async savePushToken(req, res) {
    const { push_token } = req.body;
    if (!push_token) return res.status(400).json({ error: 'push_token required' });
    try {
      await db.query(
        `UPDATE drivers SET push_token = $1, updated_at = NOW() WHERE id = $2`,
        [push_token, req.userId]
      );
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Failed to save push token' });
    }
  }

    // Register or update the Expo push token for this driver.
    // Called from the driver app on startup after asking for notification permission.
    static async registerPushToken(req, res) {
      const { push_token } = req.body;
      if (!push_token || !String(push_token).startsWith("ExponentPushToken[")) {
        return res.status(400).json({ error: "A valid Expo push token is required" });
      }
      try {
        await saveDriverPushToken(req.userId, push_token);
        res.json({ success: true });
      } catch (err) {
        res.status(500).json({ error: "Failed to register push token" });
      }
    }
}

module.exports = DriverController;
