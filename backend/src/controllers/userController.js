const User = require("../models/User");
const { saveUserPushToken } = require("../services/notificationService");

class UserController {
  static async getProfile(req, res) {
    try {
      const user = await User.findById(req.userId, "users");
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      const { password_hash, ...safeUser } = user;
      res.json({ user: safeUser });
    } catch (err) {
      console.error("[User] getProfile error:", err.message);
      res.status(500).json({ error: "Failed to fetch profile" });
    }
  }

  static async updateProfile(req, res) {
    const { name, phone, address, email } = req.body;
    try {
      const user = await User.updateProfile(req.userId, {
        name,
        phone,
        address,
        email,
      });
      const { password_hash, ...safeUser } = user;
      res.json({ user: safeUser });
    } catch (err) {
      if (err.message === "Email already in use") {
        return res.status(409).json({ error: "Email already in use" });
      }
      console.error("[User] updateProfile error:", err.message);
      res.status(500).json({ error: "Failed to update profile" });
    }
  }

  static async getOrders(req, res) {
    const page = Math.max(1, parseInt(req.query.page || "1"));
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || "20")));

    try {
      const orders = await User.getOrders(req.userId, page, limit);
      res.json({ orders, page, limit, hasMore: orders.length === limit });
    } catch (err) {
      console.error("[User] getOrders error:", err.message);
      res.status(500).json({ error: "Failed to fetch orders" });
    }
  }

    // Register or update the Expo push token for the current user.
    static async registerPushToken(req, res) {
      const { push_token } = req.body;
      if (!push_token || !String(push_token).startsWith("ExponentPushToken[")) {
        return res.status(400).json({ error: "A valid Expo push token is required" });
      }
      try {
        await saveUserPushToken(req.userId, push_token);
        res.json({ success: true });
      } catch (err) {
        console.error("[User] registerPushToken error:", err.message);
        res.status(500).json({ error: "Failed to register push token" });
      }
    }

  // Rates Flash itself, not a specific driver/delivery — the separate,
  // simple app-rating prompt shown alongside the mandatory driver rating.
  static async rateApp(req, res) {
    const { rating, comment } = req.body;
    const n = Number(rating);
    if (!Number.isInteger(n) || n < 1 || n > 5) {
      return res.status(400).json({ error: "rating must be an integer 1-5" });
    }
    try {
      await User.rateApp(req.userId, n, comment);
      res.status(201).json({ success: true });
    } catch (err) {
      console.error("[User] rateApp error:", err.message);
      res.status(500).json({ error: "Failed to save rating" });
    }
  }

  // H8 FIX: account deletion had no backend endpoint at all — the client
  // stub (services/api.js) called DELETE /users/account against a route
  // that never existed.
  static async deleteAccount(req, res) {
    try {
      await User.deleteAccount(req.userId);
      res.json({ success: true });
    } catch (err) {
      if (err.message === "ACTIVE_ORDER") {
        return res.status(409).json({ error: "You have an order in progress. Wait for it to complete or cancel it before deleting your account." });
      }
      if (err.message === "ACTIVE_SUBSCRIPTION") {
        const dateStr = new Date(err.expiresAt).toLocaleDateString('en-ZA', { year: 'numeric', month: 'long', day: 'numeric' });
        return res.status(409).json({ error: `You have an active subscription until ${dateStr}. Please wait until it expires before deleting your account.` });
      }
      if (err.message === "User not found") {
        return res.status(404).json({ error: "User not found" });
      }
      console.error("[User] deleteAccount error:", err.message);
      res.status(500).json({ error: "Failed to delete account" });
    }
  }
}

module.exports = UserController;
