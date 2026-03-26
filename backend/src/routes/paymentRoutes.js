const express = require("express");
const router = express.Router();
const { authenticate, requireRole } = require("../middleware/auth");
const PaymentController = require("../controllers/paymentController");

router.post(
  "/initialize",
  authenticate,
  requireRole("user"),
  PaymentController.initializePayment,
);
router.get("/verify/:reference", authenticate, PaymentController.verifyPayment);
router.post(
  "/cash-on-delivery",
  authenticate,
  requireRole("user"),
  PaymentController.cashOnDelivery,
);
router.post(
  "/payflex/initiate",
  authenticate,
  requireRole("user"),
  PaymentController.initiatePayflex,
);
router.get(
  "/status/:orderId",
  authenticate,
  requireRole("user"),
  PaymentController.getPaymentStatus,
);
router.get(
  "/cards",
  authenticate,
  requireRole("user"),
  PaymentController.getSavedCards,
);
router.delete(
  "/cards/:cardId",
  authenticate,
  requireRole("user"),
  PaymentController.removeCard,
);
router.patch(
  "/cards/:cardId/default",
  authenticate,
  requireRole("user"),
  PaymentController.setDefaultCard,
);
router.post(
  "/charge-saved-card",
  authenticate,
  requireRole("user"),
  PaymentController.chargeSavedCard,
);

module.exports = router;
