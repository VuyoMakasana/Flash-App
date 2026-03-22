const Admin = require("../models/Admin");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

class AdminController {
  static async login(req, res) {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }
    if (email !== process.env.ADMIN_EMAIL) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    try {
      let isValid = false;

      if (process.env.ADMIN_PASSWORD_HASH) {
        isValid = await bcrypt.compare(
          password,
          process.env.ADMIN_PASSWORD_HASH,
        );
      } else if (process.env.NODE_ENV !== "production") {
        console.warn(
          "[SECURITY] ADMIN_PASSWORD_HASH not set. Using plain-text comparison. Set it before production!",
        );
        isValid = password === process.env.ADMIN_PASSWORD;
      }

      if (!isValid) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      const token = jwt.sign(
        { id: "admin", role: "admin" },
        process.env.JWT_SECRET,
        { expiresIn: "8h" },
      );
      res.json({ token });
    } catch (err) {
      console.error("Admin login error:", err);
      res.status(500).json({ error: "Login failed" });
    }
  }

  static async getDrivers(req, res) {
    const { status } = req.query;
    try {
      const drivers = await Admin.getDrivers(status);
      res.json({ drivers });
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch drivers" });
    }
  }

  static async getDriverById(req, res) {
    const { driverId } = req.params;
    try {
      const driver = await Admin.getDriverById(driverId);
      if (!driver) {
        return res.status(404).json({ error: "Driver not found" });
      }
      res.json(driver);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch driver" });
    }
  }

  static async updateDriverStatus(req, res) {
    const { driverId } = req.params;
    const { status, notes } = req.body;
    const validStatuses = ["under_review", "approved", "rejected"];

    if (!validStatuses.includes(status)) {
      return res
        .status(400)
        .json({ error: `Status must be one of: ${validStatuses.join(", ")}` });
    }

    try {
      await Admin.updateDriverStatus(driverId, status);
      res.json({ success: true, status });
    } catch (err) {
      res.status(500).json({ error: "Failed to update driver status" });
    }
  }

  static async getOrders(req, res) {
    try {
      const orders = await Admin.getOrders();
      res.json({ orders });
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch orders" });
    }
  }

  static async getStats(req, res) {
    try {
      const stats = await Admin.getStats();
      res.json(stats);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch stats" });
    }
  }
}

module.exports = AdminController;
