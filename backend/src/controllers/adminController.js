const Admin = require("../models/Admin");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const pool = require("../config/database");
const { getRequired, isProd, isDev } = require("../config/env");

// There is no admins table — a single, config-driven admin identity
// (ADMIN_EMAIL/ADMIN_PASSWORD_HASH) is the only one this system supports.
// The JWT's `id` claim used to be the literal string "admin", which
// middleware/auth.js copies straight into req.userId for every
// admin-authenticated request. Any admin-gated write that stores
// req.userId into a UUID-typed column (e.g. return_requests.approved_by)
// crashed unconditionally with a Postgres type error. Using a real, fixed
// UUID here instead means req.userId is a valid UUID everywhere, for
// every admin action, without each write site needing to special-case it.
const ADMIN_USER_ID = "00000000-0000-0000-0000-000000000001";

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

      // H7 FIX: admin tokens previously carried no `jti`, so middleware/auth.js's
      // revocation check (`if (decoded.jti) { ... }`) silently skipped them —
      // a leaked admin token stayed valid for its full 8h life with no way to
      // kill it early, and there was no admin logout endpoint at all.
      const token = jwt.sign(
        { id: ADMIN_USER_ID, role: "admin", jti: uuidv4() },
        jwtSecret,
        { expiresIn: "8h" },
      );
      res.json({ token });
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
