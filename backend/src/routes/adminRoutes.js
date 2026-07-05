'use strict';

const express    = require('express');
const router     = express.Router();
const { authenticate, requireRole } = require('../middleware/auth');
const { validateId } = require('../middleware/validation');
const AdminController = require('../controllers/adminController');
const { adminLimiter } = require('../middleware/rateLimiter');

// POST /api/admin/login — 5 attempts per 15 min to prevent brute-force
router.post('/login', adminLimiter, AdminController.login);

router.post('/logout', authenticate, requireRole('admin'), AdminController.logout);

router.get(
  '/drivers',
  authenticate,
  requireRole('admin'),
  AdminController.getDrivers,
);

router.get(
  '/drivers/:driverId',
  authenticate,
  requireRole('admin'),
  validateId,
  AdminController.getDriverById,
);

router.put(
  '/drivers/:driverId/status',
  authenticate,
  requireRole('admin'),
  validateId,
  AdminController.updateDriverStatus,
);

router.get(
  '/orders',
  authenticate,
  requireRole('admin'),
  AdminController.getOrders,
);

router.get(
  '/stats',
  authenticate,
  requireRole('admin'),
  AdminController.getStats,
);

module.exports = router;
