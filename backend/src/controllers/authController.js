// backend/src/controllers/authController.js
// FULL REPLACEMENT FILE — includes password reset, email verification enforcement,
// and all existing functionality unchanged.
'use strict';

const jwt    = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const User   = require('../models/User');
const Driver = require('../models/Driver');
const pool   = require('../config/database');
const { generateToken, generateRefreshToken } = require('../utils/helpers');
const { validationResult } = require('express-validator');
const { verifyAppleToken }  = require('../services/appleAuthService');
const { verifyGoogleToken } = require('../services/googleAuthService');
const { sendPasswordResetEmail, sendEmailVerificationEmail } = require('../services/emailService');

const REFRESH_EXPIRY_DAYS = 7;

// ─── SHARED HELPERS ────────────────────────────────────────────────────────

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

// ─── SEND EMAIL VERIFICATION ───────────────────────────────────────────────

async function sendVerificationEmail(userId, email) {
  try {
    const token     = crypto.randomBytes(48).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    await pool.query(
      `INSERT INTO email_tokens (user_id, token, type, expires_at)
       VALUES ($1, $2, 'email_verification', $3)
       ON CONFLICT DO NOTHING`,
      [userId, token, expiresAt]
    );

    await sendEmailVerificationEmail(email, token);
  } catch (err) {
    // Non-blocking: registration still succeeds even if email fails
    console.error('[Auth] sendVerificationEmail error:', err.message);
  }
}

// ─── AUTH CONTROLLER ───────────────────────────────────────────────────────

class AuthController {

  // ── User register ──────────────────────────────────────────────────────────
  static async registerUser(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { name, email, password, phone, date_of_birth } = req.body;
    try {
      if (await User.findByEmail(email))
        return res.status(409).json({ error: 'Email already registered' });

      const user = await User.create({ name, email, password, phone, date_of_birth });
      const { accessToken, refreshToken } = await issueTokenPair(user.id, 'user');
      const { password_hash, ...safeUser } = user;

      // Send verification email (non-blocking)
      await sendVerificationEmail(user.id, user.email);

      return res.status(201).json({
        token: accessToken,
        refreshToken,
        user: safeUser,
        emailVerificationSent: true,
      });
    } catch (err) {
      console.error('[Auth] registerUser:', err.message);
      return res.status(500).json({ error: 'Registration failed' });
    }
  }

  // ── User login ─────────────────────────────────────────────────────────────
  static async loginUser(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { email, password } = req.body;
    try {
      const user = await User.verifyPassword(email, password);
      if (!user) return res.status(401).json({ error: 'Invalid email or password' });

      // ── EMAIL VERIFICATION GATE ──────────────────────────────────────────
      // Skip gate in development so local testing is not blocked.
      if (process.env.NODE_ENV === 'production' && !user.email_verified) {
        return res.status(403).json({
          error: 'Please verify your email address before logging in.',
          code:  'EMAIL_NOT_VERIFIED',
          email: user.email,
        });
      }
      // ────────────────────────────────────────────────────────────────────

      const { accessToken, refreshToken } = await issueTokenPair(user.id, 'user');
      return res.json({ token: accessToken, refreshToken, user });
    } catch (err) {
      console.error('[Auth] loginUser:', err.message);
      return res.status(500).json({ error: 'Login failed' });
    }
  }

  // ── Resend verification email ──────────────────────────────────────────────
  static async resendVerificationEmail(req, res) {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    try {
      const user = await User.findByEmail(email);
      // Always return success to avoid leaking whether the email exists
      if (!user || user.email_verified) return res.json({ success: true });

      // Invalidate old tokens for this user
      await pool.query(
        `DELETE FROM email_tokens WHERE user_id = $1 AND type = 'email_verification'`,
        [user.id]
      );

      await sendVerificationEmail(user.id, user.email);
      return res.json({ success: true });
    } catch (err) {
      console.error('[Auth] resendVerificationEmail:', err.message);
      return res.status(500).json({ error: 'Failed to resend verification email' });
    }
  }

  // ── Verify email ───────────────────────────────────────────────────────────
  static async verifyEmail(req, res) {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token required' });

    try {
      const result = await pool.query(
        `SELECT * FROM email_tokens
         WHERE token = $1
           AND type = 'email_verification'
           AND used_at IS NULL
           AND expires_at > NOW()`,
        [token]
      );

      if (!result.rows.length) {
        return res.status(400).json({ error: 'Invalid or expired verification link. Please request a new one.' });
      }

      const row = result.rows[0];

      // Mark token used + mark user verified atomically
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `UPDATE email_tokens SET used_at = NOW() WHERE id = $1`,
          [row.id]
        );
        await client.query(
          `UPDATE users SET email_verified = true, email_verified_at = NOW(), updated_at = NOW() WHERE id = $1`,
          [row.user_id]
        );
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }

      return res.json({ success: true, message: 'Email verified. You can now log in.' });
    } catch (err) {
      console.error('[Auth] verifyEmail:', err.message);
      return res.status(500).json({ error: 'Email verification failed' });
    }
  }

  // ── Forgot password ────────────────────────────────────────────────────────
  static async forgotPassword(req, res) {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    try {
      const user = await User.findByEmail(email);

      // Always return success — never reveal whether the email exists
      if (!user) return res.json({ success: true });

      // Invalidate any existing reset tokens for this user
      await pool.query(
        `DELETE FROM email_tokens WHERE user_id = $1 AND type = 'password_reset'`,
        [user.id]
      );

      // Generate a secure token
      const token     = crypto.randomBytes(48).toString('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      await pool.query(
        `INSERT INTO email_tokens (user_id, token, type, expires_at) VALUES ($1, $2, 'password_reset', $3)`,
        [user.id, token, expiresAt]
      );

      await sendPasswordResetEmail(user.email, token);

      return res.json({ success: true });
    } catch (err) {
      console.error('[Auth] forgotPassword:', err.message);
      return res.status(500).json({ error: 'Failed to send reset email' });
    }
  }

  // ── Reset password ─────────────────────────────────────────────────────────
  static async resetPassword(req, res) {
    const { token, newPassword } = req.body;
    if (!token)       return res.status(400).json({ error: 'Token required' });
    if (!newPassword) return res.status(400).json({ error: 'New password required' });
    if (newPassword.length < 10) return res.status(400).json({ error: 'Password must be at least 10 characters' });

    try {
      const result = await pool.query(
        `SELECT * FROM email_tokens
         WHERE token = $1
           AND type = 'password_reset'
           AND used_at IS NULL
           AND expires_at > NOW()`,
        [token]
      );

      if (!result.rows.length) {
        return res.status(400).json({ error: 'Invalid or expired reset link. Please request a new one.' });
      }

      const row        = result.rows[0];
      const hash       = await bcrypt.hash(newPassword, 12);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Update password
        await client.query(
          `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
          [hash, row.user_id]
        );
        // Mark token used (one-time use)
        await client.query(
          `UPDATE email_tokens SET used_at = NOW() WHERE id = $1`,
          [row.id]
        );
        // Revoke all existing refresh tokens — forces re-login on all devices
        await client.query(
          `UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`,
          [row.user_id]
        );
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }

      return res.json({ success: true, message: 'Password updated. Please log in with your new password.' });
    } catch (err) {
      console.error('[Auth] resetPassword:', err.message);
      return res.status(500).json({ error: 'Password reset failed' });
    }
  }

  // ── Google Sign In — User ──────────────────────────────────────────────────
  static async googleSignInUser(req, res) {
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ error: 'Google ID token required' });

    try {
      const googleUser = await verifyGoogleToken(idToken, [
        process.env.GOOGLE_CLIENT_ID_USER_ANDROID,
        process.env.GOOGLE_CLIENT_ID_USER_IOS,
      ]);
      const googleId   = googleUser.sub;

      // 1. Existing account by Google ID
      const byGoogle = await pool.query('SELECT * FROM users WHERE google_id = $1', [googleId]);
      if (byGoogle.rows.length) {
        const user = byGoogle.rows[0];
        const { accessToken, refreshToken } = await issueTokenPair(user.id, 'user');
        const { password_hash, ...safe } = user;
        return res.json({ token: accessToken, refreshToken, user: safe, isNewUser: false });
      }

      // 2. Link to existing email account
      if (googleUser.email) {
        const byEmail = await pool.query('SELECT * FROM users WHERE email = $1', [googleUser.email]);
        if (byEmail.rows.length) {
          const user = byEmail.rows[0];
          await pool.query(`UPDATE users SET google_id = $1, updated_at = NOW() WHERE id = $2`, [googleId, user.id]);
          const { accessToken, refreshToken } = await issueTokenPair(user.id, 'user');
          const { password_hash, ...safe } = user;
          return res.json({ token: accessToken, refreshToken, user: { ...safe, google_id: googleId }, isNewUser: false });
        }
      }

      // 3. Create new user (Google accounts are pre-verified)
      const password_hash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
      const newUser = await pool.query(
        `INSERT INTO users (name, email, password_hash, google_id, email_verified)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [
          googleUser.name || googleUser.email?.split('@')[0] || 'Flash User',
          googleUser.email || `google_${googleId.slice(-8)}@flash.private`,
          password_hash,
          googleId,
          googleUser.emailVerified, // Google accounts are pre-verified
        ]
      );

      const user = newUser.rows[0];
      const { accessToken, refreshToken } = await issueTokenPair(user.id, 'user');
      const { password_hash: _, ...safe } = user;
      return res.status(201).json({ token: accessToken, refreshToken, user: safe, isNewUser: true });

    } catch (err) {
      console.error('[GoogleAuth] User:', err.message);
      if (err.message.match(/expired|invalid|mismatch|not configured/i))
        return res.status(401).json({ error: 'Google authentication failed. Please try again.' });
      return res.status(500).json({ error: 'Sign in failed' });
    }
  }

  // ── Google Sign In — Driver ────────────────────────────────────────────────
  static async googleSignInDriver(req, res) {
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ error: 'Google ID token required' });

    try {
      const googleUser = await verifyGoogleToken(idToken, [
        process.env.GOOGLE_CLIENT_ID_DRIVER_ANDROID,
        process.env.GOOGLE_CLIENT_ID_DRIVER_IOS,
      ]);
      const googleId   = googleUser.sub;

      const byGoogle = await pool.query('SELECT * FROM drivers WHERE google_id = $1', [googleId]);
      if (byGoogle.rows.length) {
        const driver = byGoogle.rows[0];
        if (driver.status !== 'approved') {
          const msgs = { pending_documents: 'Upload documents.', documents_submitted: 'Under review.', under_review: 'Being reviewed.', rejected: 'Not approved.' };
          return res.status(403).json({ error: msgs[driver.status] || 'Not approved', status: driver.status });
        }
        const { accessToken, refreshToken } = await issueTokenPair(driver.id, 'driver');
        const { password_hash, ...safe } = driver;
        return res.json({ token: accessToken, refreshToken, driver: safe, isNewDriver: false });
      }

      if (googleUser.email) {
        const byEmail = await pool.query('SELECT * FROM drivers WHERE email = $1', [googleUser.email]);
        if (byEmail.rows.length) {
          const driver = byEmail.rows[0];
          await pool.query(`UPDATE drivers SET google_id = $1, updated_at = NOW() WHERE id = $2`, [googleId, driver.id]);
          if (driver.status !== 'approved') return res.status(403).json({ error: 'Still under review.', status: driver.status });
          const { accessToken, refreshToken } = await issueTokenPair(driver.id, 'driver');
          const { password_hash, ...safe } = driver;
          return res.json({ token: accessToken, refreshToken, driver: { ...safe, google_id: googleId }, isNewDriver: false });
        }
      }

      const password_hash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
      const newDriver = await pool.query(
        `INSERT INTO drivers (name, email, password_hash, google_id, status) VALUES ($1, $2, $3, $4, 'pending_documents') RETURNING *`,
        [
          googleUser.name || googleUser.email?.split('@')[0] || 'Flash Driver',
          googleUser.email || `google_driver_${googleId.slice(-8)}@flash.private`,
          password_hash,
          googleId,
        ]
      );

      const driver = newDriver.rows[0];
      const { accessToken, refreshToken } = await issueTokenPair(driver.id, 'driver');
      const { password_hash: _, ...safe } = driver;
      return res.status(201).json({ token: accessToken, refreshToken, driver: safe, isNewDriver: true, nextStep: 'upload_documents' });

    } catch (err) {
      console.error('[GoogleAuth] Driver:', err.message);
      if (err.message.match(/expired|invalid|mismatch|not configured/i))
        return res.status(401).json({ error: 'Google authentication failed. Please try again.' });
      return res.status(500).json({ error: 'Sign in failed' });
    }
  }

  // ── Accept terms ───────────────────────────────────────────────────────────
  static async acceptTerms(req, res) {
    try {
      await User.acceptTerms(req.userId);
      return res.json({ success: true });
    } catch (err) {
      console.error('[Auth] acceptTerms:', err.message);
      return res.status(500).json({ error: 'Failed to accept terms' });
    }
  }

  static async acceptTermsDriver(req, res) {
    try {
      await Driver.acceptTerms(req.userId);
      return res.json({ success: true });
    } catch (err) {
      console.error('[Auth] acceptTermsDriver:', err.message);
      return res.status(500).json({ error: 'Failed to accept terms' });
    }
  }

  // ── Refresh token ──────────────────────────────────────────────────────────
  static async refreshToken(req, res) {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ error: 'Refresh token required' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const result = await client.query(
        `SELECT * FROM refresh_tokens WHERE token = $1 FOR UPDATE`,
        [refreshToken]
      );

      if (!result.rows.length) {
        await client.query('ROLLBACK');
        return res.status(401).json({ error: 'Invalid refresh token' });
      }

      const row = result.rows[0];

      if (row.revoked_at !== null) {
        // Replay attack — revoke all tokens for this user
        await client.query(
          `UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`,
          [row.user_id]
        );
        await client.query('COMMIT');
        console.error(`[Auth] SECURITY: Refresh token reuse for user ${row.user_id}`);
        return res.status(401).json({ error: 'Session compromised. Please log in again.' });
      }

      if (new Date(row.expires_at) < new Date()) {
        await client.query('ROLLBACK');
        return res.status(401).json({ error: 'Refresh token expired' });
      }

      await client.query(`UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = $1`, [row.id]);

      const accessToken      = generateToken(row.user_id, row.role);
      const newRefreshToken  = generateRefreshToken();
      const expiresAt        = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      await client.query(
        `INSERT INTO refresh_tokens (user_id, role, token, expires_at) VALUES ($1, $2, $3, $4)`,
        [row.user_id, row.role, newRefreshToken, expiresAt]
      );

      await client.query('COMMIT');
      return res.json({ token: accessToken, refreshToken: newRefreshToken });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[Auth] refreshToken:', err.message);
      return res.status(500).json({ error: 'Token refresh failed' });
    } finally {
      client.release();
    }
  }

  // ── Logout ─────────────────────────────────────────────────────────────────
  static async logout(req, res) {
    const { refreshToken } = req.body;
    const authHeader       = req.headers.authorization;

    if (authHeader?.startsWith('Bearer ')) {
      try {
        const token   = authHeader.replace('Bearer ', '');
        const decoded = jwt.decode(token);
        if (decoded?.jti) {
          const expiresAt = new Date(decoded.exp * 1000);
          await pool.query(
            `INSERT INTO revoked_tokens (jti, expires_at) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [decoded.jti, expiresAt]
          );
        }
      } catch (_) {}
    }

    if (refreshToken) {
      await pool.query(
        `UPDATE refresh_tokens SET revoked_at = NOW() WHERE token = $1`,
        [refreshToken]
      ).catch(() => {});
    }

    return res.json({ success: true });
  }

  // ── Driver register ────────────────────────────────────────────────────────
  static async registerDriver(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { name, email, password, phone, vehicle_type, vehicle_plate, date_of_birth } = req.body;
    try {
      if (await Driver.findByEmail(email))
        return res.status(409).json({ error: 'Email already registered' });

      const driver = await Driver.create({ name, email, password, phone, vehicle_type, vehicle_plate, date_of_birth });
      const { password_hash, ...safe } = driver;
      const { accessToken, refreshToken } = await issueTokenPair(driver.id, 'driver');

      return res.status(201).json({
        token: accessToken,
        refreshToken,
        driver: safe,
        isNewDriver: true,
        nextStep: 'upload_documents',
        requiresApproval: true,
      });
    } catch (err) {
      console.error('[Auth] registerDriver:', err.message);
      return res.status(500).json({ error: 'Registration failed' });
    }
  }

  // ── Driver login ───────────────────────────────────────────────────────────
  static async loginDriver(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { email, password } = req.body;
    try {
      const driver = await Driver.verifyPassword(email, password);
      if (!driver) return res.status(401).json({ error: 'Invalid email or password' });

      if (driver.status !== 'approved') {
        const msgs = {
          pending_documents:   'Please upload your required documents.',
          documents_submitted: 'Documents under review.',
          under_review:        'Application being reviewed.',
          rejected:            'Application not approved. Contact support.',
          // Previously missing — fell through to the generic "Account not
          // approved" message, indistinguishable from a brand-new applicant.
          suspended:           'Account suspended. Contact makasanaivyson@gmail.com.',
        };
        return res.status(403).json({ error: msgs[driver.status] || 'Account not approved', status: driver.status });
      }

      const { accessToken, refreshToken } = await issueTokenPair(driver.id, 'driver');
      return res.json({ token: accessToken, refreshToken, driver });
    } catch (err) {
      console.error('[Auth] loginDriver:', err.message);
      return res.status(500).json({ error: 'Login failed' });
    }
  }

  // ── Apple Sign In — User ───────────────────────────────────────────────────
  static async appleSignInUser(req, res) {
    const { identityToken, fullName, email: providedEmail } = req.body;
    if (!identityToken) return res.status(400).json({ error: 'Apple identity token required' });

    try {
      const clientId  = process.env.APPLE_CLIENT_ID || 'co.za.flash.userapp';
      const appleUser = await verifyAppleToken(identityToken, clientId);
      const appleId   = appleUser.sub;

      const byApple = await pool.query('SELECT * FROM users WHERE apple_id = $1', [appleId]);
      if (byApple.rows.length) {
        const user = byApple.rows[0];
        const { accessToken, refreshToken } = await issueTokenPair(user.id, 'user');
        const { password_hash, ...safe } = user;
        return res.json({ token: accessToken, refreshToken, user: safe, isNewUser: false });
      }

      const email = appleUser.email || providedEmail || null;
      if (email) {
        const byEmail = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (byEmail.rows.length) {
          const user = byEmail.rows[0];
          await pool.query('UPDATE users SET apple_id = $1, updated_at = NOW() WHERE id = $2', [appleId, user.id]);
          const { accessToken, refreshToken } = await issueTokenPair(user.id, 'user');
          const { password_hash, ...safe } = user;
          return res.json({ token: accessToken, refreshToken, user: { ...safe, apple_id: appleId }, isNewUser: false });
        }
      }

      const name = fullName?.givenName
        ? `${fullName.givenName} ${fullName.familyName || ''}`.trim()
        : email?.split('@')[0] || 'Flash User';

      const newUser = await User.createWithApple({
        name,
        email: email || `apple_${appleId.slice(-8)}@flash.private`,
        appleId,
        placeholderPassword: crypto.randomBytes(32).toString('hex'),
        emailVerified: appleUser.emailVerified,
      });

      const { accessToken, refreshToken } = await issueTokenPair(newUser.id, 'user');
      const { password_hash, ...safe } = newUser;
      return res.status(201).json({ token: accessToken, refreshToken, user: safe, isNewUser: true });

    } catch (err) {
      console.error('[AppleAuth] User:', err.message);
      if (err.message.match(/expired|invalid|mismatch/i))
        return res.status(401).json({ error: 'Apple authentication failed. Please try again.' });
      return res.status(500).json({ error: 'Sign in failed' });
    }
  }

  // ── Apple Sign In — Driver ─────────────────────────────────────────────────
  static async appleSignInDriver(req, res) {
    const { identityToken, fullName, email: providedEmail } = req.body;
    if (!identityToken) return res.status(400).json({ error: 'Apple identity token required' });

    try {
      const clientId  = process.env.APPLE_DRIVER_CLIENT_ID || 'co.za.flash.driverapp';
      const appleUser = await verifyAppleToken(identityToken, clientId);
      const appleId   = appleUser.sub;

      const byApple = await pool.query('SELECT * FROM drivers WHERE apple_id = $1', [appleId]);
      if (byApple.rows.length) {
        const driver = byApple.rows[0];
        if (driver.status !== 'approved') {
          const msgs = { pending_documents: 'Upload documents.', documents_submitted: 'Under review.', under_review: 'Being reviewed.', rejected: 'Not approved.' };
          return res.status(403).json({ error: msgs[driver.status] || 'Not approved', status: driver.status });
        }
        const { accessToken, refreshToken } = await issueTokenPair(driver.id, 'driver');
        const { password_hash, ...safe } = driver;
        return res.json({ token: accessToken, refreshToken, driver: safe, isNewDriver: false });
      }

      const email = appleUser.email || providedEmail || null;
      if (email) {
        const byEmail = await pool.query('SELECT * FROM drivers WHERE email = $1', [email]);
        if (byEmail.rows.length) {
          const driver = byEmail.rows[0];
          await pool.query('UPDATE drivers SET apple_id = $1, updated_at = NOW() WHERE id = $2', [appleId, driver.id]);
          if (driver.status !== 'approved') return res.status(403).json({ error: 'Still under review.', status: driver.status });
          const { accessToken, refreshToken } = await issueTokenPair(driver.id, 'driver');
          const { password_hash, ...safe } = driver;
          return res.json({ token: accessToken, refreshToken, driver: { ...safe, apple_id: appleId }, isNewDriver: false });
        }
      }

      const name = fullName?.givenName
        ? `${fullName.givenName} ${fullName.familyName || ''}`.trim()
        : email?.split('@')[0] || 'Flash Driver';

      const hash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
      const newDriver = await pool.query(
        `INSERT INTO drivers (name, email, password_hash, apple_id, status) VALUES ($1,$2,$3,$4,'pending_documents') RETURNING *`,
        [name, email || `apple_driver_${appleId.slice(-8)}@flash.private`, hash, appleId]
      );
      const driver = newDriver.rows[0];
      const { accessToken, refreshToken } = await issueTokenPair(driver.id, 'driver');
      const { password_hash, ...safe } = driver;
      return res.status(201).json({ token: accessToken, refreshToken, driver: safe, isNewDriver: true, nextStep: 'upload_documents' });

    } catch (err) {
      console.error('[AppleAuth] Driver:', err.message);
      if (err.message.match(/expired|invalid|mismatch/i))
        return res.status(401).json({ error: 'Apple authentication failed. Please try again.' });
      return res.status(500).json({ error: 'Sign in failed' });
    }
  }
}

module.exports = AuthController;
