const Subscription = require("../models/Subscription");
const { PLANS } = require("../utils/constants");
const pool = require("../config/database");

class SubscriptionController {
  // TEMPORARY, TEST-ONLY - see subscriptionRoutes.js comment. Remove both
  // together once the real test account has been activated.
  static async testActivateDriverPlan(req, res) {
    const TEST_EMAIL = "makasanaivyson@gmail.com";
    const { email, confirm, planId } = req.body;
    if (email !== TEST_EMAIL || confirm !== "yes-manual-test-activation") {
      return res.status(403).json({ error: "Not authorized for this test action" });
    }
    const plan = PLANS[planId];
    if (!plan) return res.status(400).json({ error: "Invalid plan" });

    try {
      const driverResult = await pool.query(
        "SELECT id FROM drivers WHERE email=$1",
        [TEST_EMAIL],
      );
      if (!driverResult.rows.length) {
        return res.status(404).json({ error: "Test driver account not found" });
      }
      const driverId = driverResult.rows[0].id;
      const reference = `MANUAL_TEST_ACTIVATION_${Date.now()}`;
      const sub = await Subscription.activateDriverPlan(driverId, planId, reference);
      res.json({ success: true, subscription: sub });
    } catch (err) {
      console.error("Test activation error:", err);
      res.status(500).json({ error: "Test activation failed", debugMessage: err.message });
    }
  }

  static async getDriverSubscription(req, res) {
    try {
      const subscription = await Subscription.getDriverSubscription(req.userId);
      res.json({ subscription: subscription || null });
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch subscription" });
    }
  }

  static async purchaseDriverPlan(req, res) {
    const { planId } = req.body;
    const plan = PLANS[planId];
    if (!plan) {
      return res.status(400).json({ error: "Invalid plan" });
    }

    try {
      const result = await Subscription.purchaseDriverPlan(
        req.userId,
        planId,
        plan,
      );
      res.json(result);
    } catch (err) {
      console.error("Subscription purchase error:", err);
      // TEMPORARY DIAGNOSTIC: surfacing err.message to trace a real,
      // live-reproduced failure with no other log access available.
      // Not a secret - just the thrown error text. Revert once resolved.
      res.status(500).json({ error: "Failed to purchase subscription", debugMessage: err.message });
    }
  }

  static async incrementDeliveryCount(req, res) {
    try {
      await Subscription.incrementDeliveryCount(req.userId);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to increment" });
    }
  }

  static async getPremiumStatus(req, res) {
    try {
      const premium = await Subscription.getPremiumStatus(req.userId);
      res.json(premium);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch premium status" });
    }
  }

  static async purchasePremium(req, res) {
    try {
      const result = await Subscription.purchasePremium(req.userId);
      res.json(result);
    } catch (err) {
      console.error("Premium purchase error:", err);
      res.status(500).json({ error: "Failed to activate premium" });
    }
  }
}

module.exports = SubscriptionController;
