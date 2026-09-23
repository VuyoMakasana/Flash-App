'use strict';

const StoreUser = require("../models/StoreUser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const pool = require("../config/database");
const { getRequired } = require("../config/env");
const { sendStorePasswordResetEmail } = require("../services/emailService");
const { validationResult } = require("express-validator");

// Admin Platform Phase 3 — a genuinely separate auth system for partner-store
// staff, structurally mirroring AdminController's own real, proven
// login/logout/forgot-password/change-password pattern (single access
// token, no refresh-token flow, jti-based revocation on logout) rather than
// the user/driver refresh-token flow — a deliberate, founder-confirmed
// choice, not an oversight. Never touches admins/users/drivers or their
// tokens; store_users is its own table, STORE_JWT_SECRET its own secret.
class StoreAuthController {
  static async login(req, res) {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }

    try {
      const storeUser = await StoreUser.findByEmail(email);
      if (!storeUser || !storeUser.is_active) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      const isValid = await bcrypt.compare(password, storeUser.password_hash);
      if (!isValid) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      // Marketing accounts can be created but don't get login access yet —
      // no real screen exists for them (matching the store-portal frontend's
      // own roleNav.js, which has no route for 'marketing'). Checked only
      // after the password is confirmed correct, not before — rejecting on
      // role alone before credentials are verified would leak "this email
      // belongs to a marketing account" to anyone who merely guesses the
      // email, the same anti-enumeration discipline used everywhere else in
      // this codebase.
      if (storeUser.role === "marketing") {
        return res.status(403).json({ error: "Marketing access isn't available yet. Contact your store Owner." });
      }

      const storeJwtSecret = getRequired("STORE_JWT_SECRET", "store-auth");
      if (!storeJwtSecret) {
        return res.status(500).json({ error: "Authentication system misconfigured. [ERR_STORE_JWT_CONFIG]" });
      }

      const token = jwt.sign(
        { id: storeUser.id, storeId: storeUser.store_id, role: storeUser.role, jti: uuidv4() },
        storeJwtSecret,
        { expiresIn: "8h" },
      );
      res.json({
        token,
        storeUser: {
          id: storeUser.id,
          storeId: storeUser.store_id,
          name: storeUser.name,
          email: storeUser.email,
          role: storeUser.role,
        },
        forcePasswordReset: !!storeUser.force_password_reset,
      });
    } catch (err) {
      console.error("[Store Auth] Login error:", err.message);
      res.status(500).json({ error: "Login failed" });
    }
  }

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

  // Any non-Owner role can delete their own account via real self-service;
  // Owner is deliberately excluded (closing a store's relationship with
  // Flash is a Flash-side action, not a self-service button).
  static async deleteAccount(req, res) {
    if (req.storeRole === "owner") {
      return res.status(403).json({
        error: "Owner accounts can't be deleted through self-service. Contact Flash support to close your store's account.",
      });
    }

    try {
      await StoreUser.anonymize(req.storeUserId, req.storeId);

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

      res.json({ success: true });
    } catch (err) {
      console.error("[Store Auth] deleteAccount error:", err.message);
      res.status(500).json({ error: "Failed to delete account" });
    }
  }

  // ── Change password (authenticated) ────────────────────────────────────────
  // Same shape as AdminController.changePassword — requires the current
  // password, invalidates every other session via password_changed_at
  // (middleware/auth.js's authenticateStore), returns a fresh replacement
  // token so this request's own session isn't logged out by its own success.
  static async changePassword(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { currentPassword, newPassword } = req.body;

    try {
      const currentResult = await pool.query("SELECT * FROM store_users WHERE id = $1", [req.storeUserId]);
      const current = currentResult.rows[0];
      if (!current) return res.status(404).json({ error: "Account not found" });

      const isValid = await bcrypt.compare(currentPassword, current.password_hash);
      if (!isValid) return res.status(401).json({ error: "Current password is incorrect" });

      const hash = await bcrypt.hash(newPassword, 12);
      await pool.query(
        `UPDATE store_users SET password_hash = $1, password_changed_at = NOW(), force_password_reset = false, updated_at = NOW() WHERE id = $2`,
        [hash, req.storeUserId],
      );

      const storeJwtSecret = getRequired("STORE_JWT_SECRET", "store-auth");
      const token = jwt.sign(
        { id: current.id, storeId: current.store_id, role: current.role, jti: uuidv4() },
        storeJwtSecret,
        { expiresIn: "8h" },
      );

      res.json({ success: true, message: "Password updated.", token });
    } catch (err) {
      console.error("[Store Auth] changePassword:", err.message);
      res.status(500).json({ error: "Password change failed" });
    }
  }

  // ── Forgot password ────────────────────────────────────────────────────────
  static async forgotPassword(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { email } = req.body;

    try {
      const storeUser = await StoreUser.findByEmail(email);
      // Same "never reveal whether the account exists" contract as
      // authController.js/adminController.js — always { success: true }.
      // Also applies to a real-but-deactivated account, for the same reason.
      if (!storeUser || !storeUser.is_active) return res.json({ success: true });

      await pool.query(`DELETE FROM store_password_tokens WHERE store_user_id = $1`, [storeUser.id]);

      const token = crypto.randomBytes(48).toString("hex");
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

      await pool.query(
        `INSERT INTO store_password_tokens (store_user_id, token, expires_at) VALUES ($1, $2, $3)`,
        [storeUser.id, token, expiresAt],
      );

      sendStorePasswordResetEmail(storeUser.email, token).catch((err) => {
        console.error("[Store Auth] sendStorePasswordResetEmail error:", err.message);
      });

      return res.json({ success: true });
    } catch (err) {
      console.error("[Store Auth] forgotPassword:", err.message);
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
        `SELECT * FROM store_password_tokens WHERE token = $1 AND used_at IS NULL AND expires_at > NOW()`,
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
          `UPDATE store_users SET password_hash = $1, password_changed_at = NOW(), force_password_reset = false, updated_at = NOW() WHERE id = $2`,
          [hash, row.store_user_id],
        );
        await client.query(`UPDATE store_password_tokens SET used_at = NOW() WHERE id = $1`, [row.id]);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }

      return res.json({ success: true, message: "Password updated. Please log in with your new password." });
    } catch (err) {
      console.error("[Store Auth] resetPassword:", err.message);
      return res.status(500).json({ error: "Password reset failed" });
    }
  }
}

module.exports = StoreAuthController;
