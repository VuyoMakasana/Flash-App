const Admin = require("../models/Admin");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { getRequired, isProd, isDev } = require("../config/env");

class AdminController {
  static async login(req, res) {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }

    const adminEmail = process.env.ADMIN_EMAIL;
    if (email !== adminEmail) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    try {
      let isValid = false;
      const passwordHash = process.env.ADMIN_PASSWORD_HASH;
      const plainPassword = process.env.ADMIN_PASSWORD;

      // Production: MUST use bcrypt hash
      if (isProd) {
        if (!passwordHash) {
          console.error("[Admin Auth] CRITICAL: ADMIN_PASSWORD_HASH required in production");
          return res.status(500).json({
            error:
              "Admin authentication system misconfigured. [ERR_ADMIN_CONFIG]",
          });
        }
        isValid = await bcrypt.compare(password, passwordHash);
      } else {
        // Development: Try hashed first, then fallback to plain-text with warning
        if (passwordHash) {
          try {
            isValid = await bcrypt.compare(password, passwordHash);
          } catch (e) {
            console.warn(
              "[Admin Auth] Hash comparison failed, trying plain-text fallback",
            );
            isValid = false;
          }
        }

        if (!isValid && plainPassword) {
          console.warn(
            "[Admin Auth]   SECURITY: Using plain-text password comparison. Set ADMIN_PASSWORD_HASH before production!",
          );
          isValid = password === plainPassword;
        }

        if (!passwordHash && !plainPassword) {
          console.warn(
            "[Admin Auth]   Neither ADMIN_PASSWORD_HASH nor ADMIN_PASSWORD configured",
          );
        }
      }

      if (!isValid) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      const jwtSecret = getRequired("JWT_SECRET", "admin-auth");
      if (!jwtSecret) {
        return res.status(500).json({
          error: "Authentication system misconfigured. [ERR_JWT_CONFIG]",
        });
      }

      const token = jwt.sign(
        { id: "admin", role: "admin" },
        jwtSecret,
        { expiresIn: "8h" },
      );
      res.json({ token });
    } catch (err) {
      console.error("[Admin Auth] Login error:", err.message);
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
