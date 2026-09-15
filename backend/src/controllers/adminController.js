const Admin = require("../models/Admin");
const AdminAction = require("../models/AdminAction");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const pool = require("../config/database");
const { getRequired } = require("../config/env");
const { sendAdminPasswordResetEmail } = require("../services/emailService");
const { validationResult } = require("express-validator");

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
      res.json({
        token,
        admin: { id: admin.id, name: admin.name, email: admin.email, role: admin.role },
        // Admin Platform Phase 2: lets a consuming client prompt immediately,
        // but this is a UX nicety only — the real enforcement is server-side
        // (requireAdminPasswordCurrent, middleware/auth.js), not this flag.
        forcePasswordReset: !!admin.force_password_reset,
      });
    } catch (err) {
      console.error("[Admin Auth] Login error:", err.message);
      res.status(500).json({ error: "Login failed" });
    }
  }

  // ── Change password (authenticated) ────────────────────────────────────────
  // Admin Platform Phase 2. Requires the current password (never trusts an
  // authenticated session alone to change it — same standard every real
  // password-change flow needs, matching the task's explicit ask). Setting
  // password_changed_at invalidates every other currently-issued token for
  // this admin on its next use (middleware/auth.js) — including, by
  // default, the very token this request itself used, which is why a fresh
  // replacement token is minted and returned below so this session isn't
  // logged out by its own successful request.
  static async changePassword(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { currentPassword, newPassword } = req.body;

    try {
      // authenticate() (middleware/auth.js) only sets req.userId/req.userRole
      // from the JWT — no email claim to look up by, so this looks up the
      // real current row (and its live password_hash) by id directly.
      const currentResult = await pool.query("SELECT * FROM admins WHERE id = $1", [req.userId]);
      const current = currentResult.rows[0];
      if (!current) return res.status(404).json({ error: "Admin not found" });

      const isValid = await bcrypt.compare(currentPassword, current.password_hash);
      if (!isValid) return res.status(401).json({ error: "Current password is incorrect" });

      const hash = await bcrypt.hash(newPassword, 12);
      await pool.query(
        `UPDATE admins SET password_hash = $1, password_changed_at = NOW(), force_password_reset = false, updated_at = NOW() WHERE id = $2`,
        [hash, req.userId],
      );

      const jwtSecret = getRequired("ADMIN_JWT_SECRET", "admin-auth");
      const token = jwt.sign(
        { id: current.id, role: current.role, jti: uuidv4() },
        jwtSecret,
        { expiresIn: "8h" },
      );

      AdminAction.log(req.userId, "admin_password_change", "admins", req.userId);
      return res.json({ success: true, message: "Password updated.", token });
    } catch (err) {
      console.error("[Admin Auth] changePassword:", err.message);
      return res.status(500).json({ error: "Password change failed" });
    }
  }

  // ── Forgot password ────────────────────────────────────────────────────────
  // Same "never reveal whether the account exists" contract as
  // authController.js's forgotPassword (user/driver) — always returns
  // { success: true } regardless of whether the email matches a real admin.
  static async forgotPassword(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { email } = req.body;

    try {
      const admin = await Admin.findByEmail(email);
      if (!admin) return res.json({ success: true });

      await pool.query(`DELETE FROM admin_password_tokens WHERE admin_id = $1`, [admin.id]);

      const token = crypto.randomBytes(48).toString("hex");
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour, matches authController.js

      await pool.query(
        `INSERT INTO admin_password_tokens (admin_id, token, expires_at) VALUES ($1, $2, $3)`,
        [admin.id, token, expiresAt],
      );

      // Not awaited — same hang-risk fix as authController.js's forgotPassword.
      sendAdminPasswordResetEmail(admin.email, token).catch((err) => {
        console.error("[Admin Auth] sendAdminPasswordResetEmail error:", err.message);
      });

      return res.json({ success: true });
    } catch (err) {
      console.error("[Admin Auth] forgotPassword:", err.message);
      return res.status(500).json({ error: "Failed to send reset email" });
    }
  }

  // ── Reset password (token-based, unauthenticated) ──────────────────────────
  static async resetPassword(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { token, newPassword } = req.body;

    try {
      const result = await pool.query(
        `SELECT * FROM admin_password_tokens WHERE token = $1 AND used_at IS NULL AND expires_at > NOW()`,
        [token],
      );
      if (!result.rows.length) {
        return res.status(400).json({ error: "Invalid or expired reset link. Please request a new one." });
      }
      const row = result.rows[0];
      const hash = await bcrypt.hash(newPassword, 12);

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `UPDATE admins SET password_hash = $1, password_changed_at = NOW(), force_password_reset = false, updated_at = NOW() WHERE id = $2`,
          [hash, row.admin_id],
        );
        await client.query(`UPDATE admin_password_tokens SET used_at = NOW() WHERE id = $1`, [row.id]);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }

      AdminAction.log(row.admin_id, "admin_password_reset", "admins", row.admin_id);
      return res.json({ success: true, message: "Password updated. Please log in with your new password." });
    } catch (err) {
      console.error("[Admin Auth] resetPassword:", err.message);
      return res.status(500).json({ error: "Password reset failed" });
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
