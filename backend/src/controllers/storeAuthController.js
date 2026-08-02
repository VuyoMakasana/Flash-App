const StoreUser = require("../models/StoreUser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const pool = require("../config/database");
const { getRequired } = require("../config/env");

// Multi-tenant Stage 2 (docs/audits/FLASH_STORE_ADMIN_DESIGN.md §3.2) — a
// genuinely separate auth system for partner-store staff, structurally
// mirroring AdminController's own real, proven login/logout pattern
// (single access token, no refresh-token flow, jti-based revocation on
// logout) rather than the user/driver refresh-token flow — a deliberate,
// founder-confirmed choice, not an oversight. Never touches admins/users/
// drivers or their tokens; store_users is its own table, STORE_JWT_SECRET
// its own secret.
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

      // Multi-tenant Stage 6, founder decision — Marketing accounts can be
      // created (Stage 5's createStaff already allows the role) but don't
      // get login access yet, since no real screen exists for them.
      // Checked only after the password is confirmed correct, not before —
      // rejecting on role alone before credentials are verified would leak
      // "this email belongs to a marketing account" to anyone who merely
      // guesses the email, the same anti-enumeration discipline already
      // applied everywhere else in this codebase.
      if (storeUser.role === "marketing") {
        return res.status(403).json({ error: "Marketing access isn't available yet. Contact your store Owner." });
      }

      const storeJwtSecret = getRequired("STORE_JWT_SECRET", "store-auth");
      if (!storeJwtSecret) {
        return res.status(500).json({
          error: "Authentication system misconfigured. [ERR_STORE_JWT_CONFIG]",
        });
      }

      // jti mirrors AdminController.login's own reasoning exactly: a leaked
      // store-account token can be killed early via logout, not just left
      // valid for its full 8h life.
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
      });
    } catch (err) {
      console.error("[Store Auth] Login error:", err.message);
      res.status(500).json({ error: "Login failed" });
    }
  }

  // Revokes the current token immediately via the same shared revoked_tokens
  // table + jti mechanism used for user/driver/admin logout — reused as-is,
  // not duplicated, since it holds no tenant-identifying data (a bare jti
  // blocklist), unlike store_users itself which must never be shared.
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

  // Multi-tenant Stage 6, founder decision — any non-Owner role can delete
  // their own account via real self-service; Owner is deliberately excluded
  // (closing a store's relationship with Flash is a Flash Admin action, not
  // a self-service button) -- same spirit as Stage 5's self-lockout guard,
  // just phrased as an outright rejection instead of a scoping check, since
  // there's no "own account" ambiguity here to scope against.
  static async deleteAccount(req, res) {
    if (req.storeRole === "owner") {
      return res.status(403).json({
        error: "Owner accounts can't be deleted through self-service. Contact Flash support to close your store's account.",
      });
    }

    try {
      await StoreUser.anonymize(req.storeUserId, req.storeId);

      // Same real jti + revoked_tokens mechanism as User.deleteAccount/
      // Driver.deleteAccount's own access-token-revocation fix -- the
      // current token must die immediately, not just once it naturally
      // expires up to 8h later.
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
}

module.exports = StoreAuthController;
