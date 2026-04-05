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
        res.status(500).json({ error: "Failed to register push token" });
      }
    }
}

module.exports = UserController;
