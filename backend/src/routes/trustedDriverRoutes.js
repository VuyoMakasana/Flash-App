'use strict';

/**
 * trustedDriverRoutes.js
 *
 * HIGH-5 FIX: validateId middleware applied to all routes that accept
 *   :driverId, :requestId, or :userId params. Without it, invalid UUIDs
 *   caused PostgreSQL errors that leaked internal state.
 *
 * HIGH-2 FIX: trustRequestLimiter applied to the POST /:driverId/request
 *   route (3 requests per hour per IP/user).
 */

const express = require('express');
const router  = express.Router();
const { authenticate, requireRole } = require('../middleware/auth');
const { validateId }                = require('../middleware/validation');
const { trustRequestLimiter }       = require('../middleware/rateLimiter');
const TrustedDriverController       = require('../controllers/trustedDriverController');

router.get(
  '/',
  authenticate,
  requireRole('user'),
  TrustedDriverController.getTrustedDrivers,
);

router.get(
  '/pending',
  authenticate,
  requireRole('user'),
  TrustedDriverController.getPendingRequests,
);

router.post(
  '/:driverId/request',
  authenticate,
  requireRole('user'),
  validateId('driverId'),
  trustRequestLimiter,
  TrustedDriverController.sendTrustRequest,
);

router.delete(
  '/:driverId',
  authenticate,
  requireRole('user'),
  validateId('driverId'),
  TrustedDriverController.removeTrustedDriver,
);

router.get(
  '/requests',
  authenticate,
  requireRole('driver'),
  TrustedDriverController.getDriverRequests,
);

router.patch(
  '/:requestId/respond',
  authenticate,
  requireRole('driver'),
  validateId('requestId'),
  TrustedDriverController.respondToRequest,
);

router.delete(
  '/remove-self/:userId',
  authenticate,
  requireRole('driver'),
  validateId('userId'),
  TrustedDriverController.removeSelf,
);

router.get(
  '/:driverId/status',
  authenticate,
  requireRole('user'),
  validateId('driverId'),
  TrustedDriverController.checkDriverStatus,
);

module.exports = router;
