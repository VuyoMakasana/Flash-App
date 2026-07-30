const express = require("express");
const router = express.Router();
const { authenticate, requireRole } = require("../middleware/auth");
const SubscriptionController = require("../controllers/subscriptionController");

router.get(
  "/driver",
  authenticate,
  requireRole("driver"),
  SubscriptionController.getDriverSubscription,
);
router.post(
  "/driver/purchase",
  authenticate,
  requireRole("driver"),
  SubscriptionController.purchaseDriverPlan,
);
router.post(
  "/driver/increment",
  authenticate,
  requireRole("driver"),
  SubscriptionController.incrementDeliveryCount,
);
router.post(
  "/driver/cancel",
  authenticate,
  requireRole("driver"),
  SubscriptionController.cancelDriverPlan,
);
router.get(
  "/premium",
  authenticate,
  requireRole("user"),
  SubscriptionController.getPremiumStatus,
);
router.post(
  "/premium/purchase",
  authenticate,
  requireRole("user"),
  SubscriptionController.purchasePremium,
);
router.post(
  "/premium/purchase-with-card",
  authenticate,
  requireRole("user"),
  SubscriptionController.purchasePremiumWithCard,
);
router.post(
  "/premium/cancel",
  authenticate,
  requireRole("user"),
  SubscriptionController.cancelPremium,
);

module.exports = router;
