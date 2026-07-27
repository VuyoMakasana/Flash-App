const Admin = require("../models/Admin");
const AdminAction = require("../models/AdminAction");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const pool = require("../config/database");
const { getRequired } = require("../config/env");

class AdminController {
  // ADMIN PANEL PHASE 0 (docs/audits/ADMIN_PANEL_AUDIT_AND_VISION.md):
  // real, individual admin accounts, replacing the single shared
  // ADMIN_EMAIL/ADMIN_PASSWORD_HASH identity entirely — not run alongside it.
  // Each admin now has a real row (admins.id) and a real bcrypt hash of
  // their own; the JWT's `id` claim is that real UUID, so every admin-gated
  // write (e.g. return_requests.approved_by) records who actually did it.
  // Signed with ADMIN_JWT_SECRET, not the shared JWT_SECRET user/driver
  // tokens use — a real, cheap isolation improvement (see middleware/auth.js).
  static async login(req, res) {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }

    try {
      const admin = await Admin.findByEmail(email);
      if (!admin) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      const isValid = await bcrypt.compare(password, admin.password_hash);
      if (!isValid) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      const jwtSecret = getRequired("ADMIN_JWT_SECRET", "admin-auth");
      if (!jwtSecret) {
        return res.status(500).json({
          error: "Authentication system misconfigured. [ERR_JWT_CONFIG]",
        });
      }

      // H7 FIX (unchanged): admin tokens carry a jti so middleware/auth.js's
      // revocation check applies to them too — a leaked admin token can be
      // killed early via logout, not just left valid for its full 8h life.
      const token = jwt.sign(
        { id: admin.id, role: admin.role, jti: uuidv4() },
        jwtSecret,
        { expiresIn: "8h" },
      );
      res.json({ token, admin: { id: admin.id, name: admin.name, email: admin.email, role: admin.role } });
    } catch (err) {
      console.error("[Admin Auth] Login error:", err.message);
      res.status(500).json({ error: "Login failed" });
    }
  }

  // H7 FIX: revokes the admin's current token immediately via the same
  // revoked_tokens table + jti mechanism used for user/driver logout
  // (see AuthController.logout), instead of leaving it valid until it expires.
  static async logout(req, res) {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      try {
        const token = authHeader.replace("Bearer ", "");
        const decoded = jwt.decode(token);
        if (decoded?.jti) {
          const expiresAt = new Date(decoded.exp * 1000);
          await pool.query(
            `INSERT INTO revoked_tokens (jti, expires_at) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [decoded.jti, expiresAt],
          );
        }
      } catch (_) {}
    }
    return res.json({ success: true });
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
      AdminAction.log(req.userId, "driver_status_update", "drivers", driverId, { status, notes: notes || null });
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

  // Package protection / pre-pickup cancellation split visibility — the
  // exact breakdown recorded by orderController.cancelOrder, traceable per
  // order rather than buried in a generic order list.
  static async getCancellations(req, res) {
    try {
      const cancellations = await Admin.getCancellations();
      res.json({ cancellations });
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch cancellations" });
    }
  }
}

module.exports = AdminController;
