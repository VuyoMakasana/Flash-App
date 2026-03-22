const User = require("../models/User");

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
    const { name, phone, address } = req.body;
    try {
      const user = await User.updateProfile(req.userId, {
        name,
        phone,
        address,
      });
      const { password_hash, ...safeUser } = user;
      res.json({ user: safeUser });
    } catch (err) {
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
}

module.exports = UserController;
