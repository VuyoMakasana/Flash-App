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

// TEMPORARY, TEST-ONLY route — activates a driver plan without going through
// Paystack, for exactly one hardcoded test account, so real driver-flow
// testing isn't blocked on the separate PAYSTACK_SECRET_KEY production
// misconfiguration. Requires the exact test email AND a confirmation
// string, both hardcoded, so this can't be triggered by anyone else even
// while it's live. Calls the same activateDriverPlan() the real Paystack
// webhook calls — no new/untested activation logic. To be removed
// immediately after use, not a permanent feature.
router.post("/driver/test-activate", SubscriptionController.testActivateDriverPlan);

module.exports = router;
