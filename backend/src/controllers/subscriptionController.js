const Subscription = require("../models/Subscription");
const { PLANS } = require("../utils/constants");

class SubscriptionController {
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
