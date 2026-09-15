'use strict';

const express    = require('express');
const router     = express.Router();
const { body }   = require('express-validator');
const { authenticate, requireRole, requireAdminPasswordCurrent } = require('../middleware/auth');
const { validateId } = require('../middleware/validation');
const AdminController = require('../controllers/adminController');
const { adminLimiter, adminAccountLoginLimiter, adminPasswordResetLimiter } = require('../middleware/rateLimiter');

// POST /api/admin/login — adminLimiter (5/15min per IP) + adminAccountLoginLimiter
// (5/15min per account, survives an attacker spreading guesses across IPs —
// Admin Platform Phase 2).
router.post('/login', adminLimiter, adminAccountLoginLimiter, AdminController.login);

// Admin Platform Phase 2 — forgot/reset/change password. Never gated by
// requireAdminPasswordCurrent: an admin in a forced-reset state must still
// be able to log out, and change-password/reset-password are exactly how
// that state gets cleared in the first place.
router.post(
  '/forgot-password',
  adminPasswordResetLimiter,
  [body('email').isEmail().normalizeEmail()],
  AdminController.forgotPassword,
);
router.post(
  '/reset-password',
  [body('token').notEmpty(), body('newPassword').isLength({ min: 10 })],
  AdminController.resetPassword,
);
router.post(
  '/change-password',
  authenticate,
  requireRole('admin'),
  [body('currentPassword').notEmpty(), body('newPassword').isLength({ min: 10 })],
  AdminController.changePassword,
);

router.post('/logout', authenticate, requireRole('admin'), AdminController.logout);

router.get(
  '/drivers',
  authenticate,
  requireRole('admin'),
  requireAdminPasswordCurrent,
  AdminController.getDrivers,
);

router.get(
  '/drivers/:driverId',
  authenticate,
  requireRole('admin'),
  requireAdminPasswordCurrent,
  validateId,
  AdminController.getDriverById,
);

router.put(
  '/drivers/:driverId/status',
  authenticate,
  requireRole('admin'),
  requireAdminPasswordCurrent,
  validateId,
  AdminController.updateDriverStatus,
);

router.get(
  '/orders',
  authenticate,
  requireRole('admin'),
  requireAdminPasswordCurrent,
  AdminController.getOrders,
);

router.get(
  '/stats',
  authenticate,
  requireRole('admin'),
  requireAdminPasswordCurrent,
  AdminController.getStats,
);

router.get(
  '/cancellations',
  authenticate,
  requireRole('admin'),
  requireAdminPasswordCurrent,
  AdminController.getCancellations,
);

module.exports = router;
