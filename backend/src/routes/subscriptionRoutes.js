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

module.exports = router;
