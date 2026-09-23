'use strict';

const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const { authenticateStore } = require('../middleware/auth');
const StoreAuthController = require('../controllers/storeAuthController');
const { storeAuthLimiter, storeAccountLoginLimiter, storePasswordResetLimiter } = require('../middleware/rateLimiter');

// POST /api/store-auth/login — storeAuthLimiter (IP, 5/15min) +
// storeAccountLoginLimiter (per-account, 5/15min) — same dual-layer
// brute-force protection as /api/admin/login.
router.post('/login', storeAuthLimiter, storeAccountLoginLimiter, StoreAuthController.login);

router.post('/logout', authenticateStore, StoreAuthController.logout);

// No requireStoreRole restriction here — every authenticated role must be
// able to reach this route (that's the whole point of self-service
// deletion); the Owner-specific rejection is a business rule the controller
// itself decides, not a route-level access gate.
router.delete('/account', authenticateStore, StoreAuthController.deleteAccount);

// Admin Platform Phase 3 — store_users' own independent forgot/reset/
// change-password flow (the task's own explicit ask: "own independent
// forgot/change-password flow"), structurally mirroring /api/admin's.
router.post(
  '/forgot-password',
  storePasswordResetLimiter,
  [body('email').isEmail().normalizeEmail()],
  StoreAuthController.forgotPassword,
);
router.post(
  '/reset-password',
  [body('token').notEmpty(), body('newPassword').isLength({ min: 10 })],
  StoreAuthController.resetPassword,
);
router.post(
  '/change-password',
  authenticateStore,
  [body('currentPassword').notEmpty(), body('newPassword').isLength({ min: 10 })],
  StoreAuthController.changePassword,
);

module.exports = router;
