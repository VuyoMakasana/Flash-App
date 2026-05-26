const bcrypt  = require("bcryptjs");
const crypto  = require("crypto");
const User    = require("../models/User");
const Driver  = require("../models/Driver");
const pool    = require("../config/database");
const { generateToken, generateRefreshToken } = require("../utils/helpers");
const { validationResult } = require("express-validator");
const { verifyAppleToken } = require("../services/appleAuthService");

const REFRESH_EXPIRY_DAYS = 7;

// ─── SHARED HELPERS ──────────────────────────────────────────────────────────
async function issueTokenPair(id, role) {
  const accessToken  = generateToken(id, role);
  const refreshToken = generateRefreshToken();
  const expiresAt    = new Date(Date.now() + REFRESH_EXPIRY_DAYS * 86400_000);

  await pool.query(
    `INSERT INTO refresh_tokens (user_id, role, token, expires_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING`,
    [id, role, refreshToken, expiresAt]
  );
  return { accessToken, refreshToken };
}

class AuthController {

  // ── User register ───────────────────────────────────────────────────────
  static async registerUser(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { name, email, password, phone } = req.body;
    try {
      if (await User.findByEmail(email))
        return res.status(409).json({ error: "Email already registered" });

      const user = await User.create({ name, email, password, phone });
      const { accessToken, refreshToken } = await issueTokenPair(user.id, "user");
      const { password_hash, ...safeUser } = user;
      return res.status(201).json({ token: accessToken, refreshToken, user: safeUser });
    } catch (err) {
      console.error("[Auth] registerUser:", err.message);
      return res.status(500).json({ error: "Registration failed" });
    }
  }

  // ── User login ──────────────────────────────────────────────────────────
  static async loginUser(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { email, password } = req.body;
    try {
      const user = await User.verifyPassword(email, password);
      if (!user) return res.status(401).json({ error: "Invalid email or password" });

      const { accessToken, refreshToken } = await issueTokenPair(user.id, "user");
      return res.json({ token: accessToken, refreshToken, user });
    } catch (err) {
      console.error("[Auth] loginUser:", err.message);
      return res.status(500).json({ error: "Login failed" });
    }
  }

  // ── Accept terms ────────────────────────────────────────────────────────
  static async acceptTerms(req, res) {
    const jwt = require("jsonwebtoken");
    const tok = req.headers.authorization?.replace("Bearer ", "");
    if (!tok) return res.status(401).json({ error: "No token" });
    try {
      const decoded = jwt.verify(tok, process.env.JWT_SECRET);
      await User.acceptTerms(decoded.id);
      return res.json({ success: true });
    } catch (_) {
      return res.status(500).json({ error: "Failed to accept terms" });
    }
  }

  // ── Refresh token ───────────────────────────────────────────────────────
  static async refreshToken(req, res) {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ error: "Refresh token required" });

    try {
      const result = await pool.query(
        `SELECT * FROM refresh_tokens
         WHERE token = $1 AND expires_at > NOW() AND revoked_at IS NULL`,
        [refreshToken]
      );
      if (!result.rows.length)
        return res.status(401).json({ error: "Invalid or expired refresh token" });

      const row = result.rows[0];

      // Rotate: revoke old, issue new pair
      await pool.query(
        "UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = $1",
        [row.id]
      );

      const { accessToken, refreshToken: newRefresh } = await issueTokenPair(row.user_id, row.role);
      return res.json({ token: accessToken, refreshToken: newRefresh });
    } catch (err) {
      console.error("[Auth] refreshToken:", err.message);
      return res.status(500).json({ error: "Token refresh failed" });
    }
  }

  // ── Logout ──────────────────────────────────────────────────────────────
  static async logout(req, res) {
    const { refreshToken } = req.body;
    if (refreshToken) {
      await pool.query(
        "UPDATE refresh_tokens SET revoked_at = NOW() WHERE token = $1",
        [refreshToken]
      ).catch(() => {});
    }
    return res.json({ success: true });
  }

  // ── Driver register ─────────────────────────────────────────────────────
  static async registerDriver(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { name, email, password, phone, vehicle_type, vehicle_plate } = req.body;
    try {
      if (await Driver.findByEmail(email))
        return res.status(409).json({ error: "Email already registered" });

      const driver = await Driver.create({ name, email, password, phone, vehicle_type, vehicle_plate });
      const { accessToken, refreshToken } = await issueTokenPair(driver.id, "driver");
      const { password_hash, ...safeDriver } = driver;
      return res.status(201).json({ token: accessToken, refreshToken, driver: safeDriver });
    } catch (err) {
      console.error("[Auth] registerDriver:", err.message);
      return res.status(500).json({ error: "Registration failed" });
    }
  }

  // ── Driver login ─────────────────────────────────────────────────────────
  static async loginDriver(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { email, password } = req.body;
    try {
      const driver = await Driver.verifyPassword(email, password);
      if (!driver) return res.status(401).json({ error: "Invalid email or password" });

      if (driver.status !== "approved") {
        const msgs = {
          pending_documents:   "Please upload your required documents.",
          documents_submitted: "Documents under review.",
          under_review:        "Application being reviewed.",
          rejected:            "Application not approved. Contact support.",
        };
        return res.status(403).json({ error: msgs[driver.status] || "Account not approved", status: driver.status });
      }

      const { accessToken, refreshToken } = await issueTokenPair(driver.id, "driver");
      return res.json({ token: accessToken, refreshToken, driver });
    } catch (err) {
      console.error("[Auth] loginDriver:", err.message);
      return res.status(500).json({ error: "Login failed" });
    }
  }

  // ── Apple Sign In — User ─────────────────────────────────────────────────
  static async appleSignInUser(req, res) {
    const { identityToken, fullName, email: providedEmail } = req.body;
    if (!identityToken) return res.status(400).json({ error: "Apple identity token required" });

    try {
      const clientId  = process.env.APPLE_CLIENT_ID || "co.za.flash.userapp";
      const appleUser = await verifyAppleToken(identityToken, clientId);
      const appleId   = appleUser.sub;

      // 1. Existing account by Apple ID
      const byApple = await pool.query("SELECT * FROM users WHERE apple_id = $1", [appleId]);
      if (byApple.rows.length) {
        const user = byApple.rows[0];
        const { accessToken, refreshToken } = await issueTokenPair(user.id, "user");
        const { password_hash, ...safe } = user;
        return res.json({ token: accessToken, refreshToken, user: safe, isNewUser: false });
      }

      const email = appleUser.email || providedEmail || null;

      // 2. Link to existing email account
      if (email) {
        const byEmail = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
        if (byEmail.rows.length) {
          const user = byEmail.rows[0];
          await pool.query("UPDATE users SET apple_id = $1, updated_at = NOW() WHERE id = $2", [appleId, user.id]);
          const { accessToken, refreshToken } = await issueTokenPair(user.id, "user");
          const { password_hash, ...safe } = user;
          return res.json({ token: accessToken, refreshToken, user: { ...safe, apple_id: appleId }, isNewUser: false });
        }
      }

      // 3. Create new user
      const name = fullName?.givenName
        ? `${fullName.givenName} ${fullName.familyName || ""}`.trim()
        : email?.split("@")[0] || "Flash User";

      const newUser = await User.createWithApple({
        name,
        email: email || `apple_${appleId.slice(-8)}@flash.private`,
        appleId,
        placeholderPassword: crypto.randomBytes(32).toString("hex"),
        emailVerified: appleUser.emailVerified,
      });

      const { accessToken, refreshToken } = await issueTokenPair(newUser.id, "user");
      const { password_hash, ...safe } = newUser;
      return res.status(201).json({ token: accessToken, refreshToken, user: safe, isNewUser: true });

    } catch (err) {
      console.error("[AppleAuth] User:", err.message);
      if (err.message.match(/expired|invalid|mismatch/i))
        return res.status(401).json({ error: "Apple authentication failed. Please try again." });
      return res.status(500).json({ error: "Sign in failed" });
    }
  }

  // ── Apple Sign In — Driver ───────────────────────────────────────────────
  static async appleSignInDriver(req, res) {
    const { identityToken, fullName, email: providedEmail } = req.body;
    if (!identityToken) return res.status(400).json({ error: "Apple identity token required" });

    try {
      const clientId  = process.env.APPLE_DRIVER_CLIENT_ID || "co.za.flash.driverapp";
      const appleUser = await verifyAppleToken(identityToken, clientId);
      const appleId   = appleUser.sub;

      const byApple = await pool.query("SELECT * FROM drivers WHERE apple_id = $1", [appleId]);
      if (byApple.rows.length) {
        const driver = byApple.rows[0];
        if (driver.status !== "approved") {
          const msgs = { pending_documents: "Upload documents.", documents_submitted: "Under review.", under_review: "Being reviewed.", rejected: "Not approved." };
          return res.status(403).json({ error: msgs[driver.status] || "Not approved", status: driver.status });
        }
        const { accessToken, refreshToken } = await issueTokenPair(driver.id, "driver");
        const { password_hash, ...safe } = driver;
        return res.json({ token: accessToken, refreshToken, driver: safe, isNewDriver: false });
      }

      const email = appleUser.email || providedEmail || null;
      if (email) {
        const byEmail = await pool.query("SELECT * FROM drivers WHERE email = $1", [email]);
        if (byEmail.rows.length) {
          const driver = byEmail.rows[0];
          await pool.query("UPDATE drivers SET apple_id = $1, updated_at = NOW() WHERE id = $2", [appleId, driver.id]);
          if (driver.status !== "approved")
            return res.status(403).json({ error: "Still under review.", status: driver.status });
          const { accessToken, refreshToken } = await issueTokenPair(driver.id, "driver");
          const { password_hash, ...safe } = driver;
          return res.json({ token: accessToken, refreshToken, driver: { ...safe, apple_id: appleId }, isNewDriver: false });
        }
      }

      const name = fullName?.givenName
        ? `${fullName.givenName} ${fullName.familyName || ""}`.trim()
        : email?.split("@")[0] || "Flash Driver";

      const hash = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 12);
      const newDriver = await pool.query(
        `INSERT INTO drivers (name, email, password_hash, apple_id, status) VALUES ($1,$2,$3,$4,'pending_documents') RETURNING *`,
        [name, email || `apple_driver_${appleId.slice(-8)}@flash.private`, hash, appleId]
      );
      const driver = newDriver.rows[0];
      const { accessToken, refreshToken } = await issueTokenPair(driver.id, "driver");
      const { password_hash, ...safe } = driver;
      return res.status(201).json({ token: accessToken, refreshToken, driver: safe, isNewDriver: true, nextStep: "upload_documents" });

    } catch (err) {
      console.error("[AppleAuth] Driver:", err.message);
      if (err.message.match(/expired|invalid|mismatch/i))
        return res.status(401).json({ error: "Apple authentication failed. Please try again." });
      return res.status(500).json({ error: "Sign in failed" });
    }
  }
}

module.exports = AuthController;
