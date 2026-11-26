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
const { validateId } = require('../middleware/validation');
const PaymentController = require('../controllers/paymentController');
const { otpLimiter, paymentLimiter } = require('../middleware/rateLimiter');
const { requireFeature } = require('../middleware/requireFeature');

router.post(
  '/initialize',
  authenticate,
  requireRole('user'),
  requireFeature('card_payments'), // kill switch (L0.5b)
  paymentLimiter,
  PaymentController.initializePayment,
);

router.get('/verify/:reference', authenticate, PaymentController.verifyPayment);

router.post(
  '/cash-on-delivery',
  authenticate,
  requireRole('user'),
  requireFeature('cash_orders'), // kill switch (L0.5b)
  PaymentController.cashOnDelivery,
);

router.get(
  '/status/:orderId',
  authenticate,
  requireRole('user'),
  validateId,
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
  validateId,
  PaymentController.removeCard,
);

router.patch(
  '/cards/:cardId/default',
  authenticate,
  requireRole('user'),
  validateId,
  PaymentController.setDefaultCard,
);

router.post(
  '/charge-saved-card',
  authenticate,
  requireRole('user'),
  requireFeature('card_payments'), // kill switch (L0.5b)
  paymentLimiter,
  PaymentController.chargeSavedCard,
);

router.post(
  '/cash/send-otp',
  authenticate,
  requireRole('driver'),
  otpLimiter,
  PaymentController.sendCashOtp,
);

router.get(
  '/cash/otp/:orderId',
  authenticate,
  requireRole('user'),
  validateId,
  PaymentController.getCashOtp,
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
  otpLimiter,
  PaymentController.markCashFailed,
);

module.exports = router;
