const express = require("express");
const router = express.Router();
const { authenticate, requireRole } = require("../middleware/auth");
const SubscriptionController = require("../controllers/subscriptionController");
const { requireFeature } = require("../middleware/requireFeature");

router.get(
  "/driver",
  authenticate,
  requireRole("driver"),
  SubscriptionController.getDriverSubscription,
);
// Step 1 (#102), founder decision 6 (FI-127): driver plans are free, so no
// plan is ever sold. Every request is refused before anything else runs
// (no login check, no Paystack call, no database write). The purchase
// handler is kept, unused, for a later decision. 410 Gone: the feature has
// been withdrawn, not paused.
const DRIVER_PLANS_FREE_MESSAGE =
  "Driver plans are no longer sold. Going online and accepting deliveries is free.";
router.post("/driver/purchase", (_req, res) =>
  res.status(410).json({ error: DRIVER_PLANS_FREE_MESSAGE, code: "DRIVER_PLANS_FREE" }),
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
  requireFeature("premium"), // kill switch (L0.5b)
  SubscriptionController.purchasePremium,
);
router.post(
  "/premium/purchase-with-card",
  authenticate,
  requireRole("user"),
  requireFeature("premium"), // kill switch (L0.5b)
  SubscriptionController.purchasePremiumWithCard,
);
router.post(
  "/premium/cancel",
  authenticate,
  requireRole("user"),
  SubscriptionController.cancelPremium,
);

module.exports = router;
module.exports.DRIVER_PLANS_FREE_MESSAGE = DRIVER_PLANS_FREE_MESSAGE;
