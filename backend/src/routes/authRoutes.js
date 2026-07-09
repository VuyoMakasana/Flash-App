// backend/src/routes/authRoutes.js
// FULL REPLACEMENT FILE — adds forgot/reset password and email verify routes.
'use strict';

const express = require('express');
const router  = express.Router();
const { body } = require('express-validator');
const AuthController = require('../controllers/authController');
const { authLimiter } = require('../middleware/rateLimiter');
const { authenticate } = require('../middleware/auth');

// All auth routes get the strict rate limiter (10 per 15 min)
router.use(authLimiter);

// ── User Registration & Login ──────────────────────────────────────────────
router.post('/user/register',
  [body('name').trim().notEmpty(), body('email').isEmail().normalizeEmail(), body('password').isLength({ min: 10 })],
  AuthController.registerUser
);
router.post('/user/login',
  [body('email').isEmail().normalizeEmail(), body('password').notEmpty()],
  AuthController.loginUser
);
router.post('/user/apple',  [body('identityToken').notEmpty()], AuthController.appleSignInUser);
router.post('/user/google', [body('idToken').notEmpty()],       AuthController.googleSignInUser);
router.post('/user/accept-terms', authenticate, AuthController.acceptTerms);

// ── Email Verification ─────────────────────────────────────────────────────
// POST /api/auth/user/verify-email   { token: "..." }
// POST /api/auth/user/resend-verification   { email: "..." }
router.post('/user/verify-email',
  [body('token').notEmpty()],
  AuthController.verifyEmail
);
router.post('/user/resend-verification',
  [body('email').isEmail().normalizeEmail()],
  AuthController.resendVerificationEmail
);

// ── Password Reset ─────────────────────────────────────────────────────────
// POST /api/auth/user/forgot-password   { email: "..." }
// POST /api/auth/user/reset-password    { token: "...", newPassword: "..." }
router.post('/user/forgot-password',
  [body('email').isEmail().normalizeEmail()],
  AuthController.forgotPassword
);
router.post('/user/reset-password',
  [body('token').notEmpty(), body('newPassword').isLength({ min: 10 })],
  AuthController.resetPassword
);

// ── Driver Registration & Login ────────────────────────────────────────────
router.post('/driver/register',
  [body('name').trim().notEmpty(), body('email').isEmail().normalizeEmail(), body('password').isLength({ min: 10 }), body('phone').notEmpty()],
  AuthController.registerDriver
);
router.post('/driver/login',
  [body('email').isEmail().normalizeEmail(), body('password').notEmpty()],
  AuthController.loginDriver
);
router.post('/driver/apple',  [body('identityToken').notEmpty()], AuthController.appleSignInDriver);
router.post('/driver/google', [body('idToken').notEmpty()],       AuthController.googleSignInDriver);
router.post('/driver/accept-terms', authenticate, AuthController.acceptTermsDriver);

// ── Token Management ──────────────────────────────────────────────────────
router.post('/refresh', [body('refreshToken').notEmpty()], AuthController.refreshToken);
router.post('/logout',  AuthController.logout);

module.exports = router;
