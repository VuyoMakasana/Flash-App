'use strict';

/**
 * paymentRoutes.js
 *
 * CRITICAL-3 FIX: /payflex/initiate route removed.
 *   All remaining routes are Paystack and Cash-on-Delivery only.
 */

const express           = require('express');
const router            = express.Router();
const { authenticate, requireRole } = require('../middleware/auth');
const PaymentController = require('../controllers/paymentController');
const { otpLimiter }    = require('../middleware/rateLimiter');

router.post(
  '/initialize',
  authenticate,
  requireRole('user'),
  PaymentController.initializePayment,
);

router.get('/verify/:reference', authenticate, PaymentController.verifyPayment);

router.post(
  '/cash-on-delivery',
  authenticate,
  requireRole('user'),
  PaymentController.cashOnDelivery,
);

router.get(
  '/status/:orderId',
  authenticate,
  requireRole('user'),
  PaymentController.getPaymentStatus,
);

router.get(
  '/cards',
  authenticate,
  requireRole('user'),
  PaymentController.getSavedCards,
);

router.delete(
  '/cards/:cardId',
  authenticate,
  requireRole('user'),
  PaymentController.removeCard,
);

router.patch(
  '/cards/:cardId/default',
  authenticate,
  requireRole('user'),
  PaymentController.setDefaultCard,
);

router.post(
  '/charge-saved-card',
  authenticate,
  requireRole('user'),
  PaymentController.chargeSavedCard,
);

router.post(
  '/cash/send-otp',
  authenticate,
  requireRole('driver'),
  otpLimiter,
  PaymentController.sendCashOtp,
);

router.post(
  '/cash/confirm',
  authenticate,
  requireRole('driver'),
  otpLimiter,
  PaymentController.confirmCashReceived,
);

router.post(
  '/cash/fail',
  authenticate,
  requireRole('driver'),
  PaymentController.markCashFailed,
);

module.exports = router;
