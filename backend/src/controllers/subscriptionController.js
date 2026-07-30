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
      res.status(500).json({ error: "Failed to purchase subscription" });
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

  static async purchasePremiumWithCard(req, res) {
    const { cardId } = req.body;
    if (!cardId) {
      return res.status(400).json({ error: "cardId is required" });
    }
    try {
      const result = await Subscription.purchasePremiumWithSavedCard(req.userId, cardId);
      res.status(202).json(result);
    } catch (err) {
      if (err.message === "CARD_NOT_FOUND") {
        return res.status(404).json({ error: "Saved card not found" });
      }
      console.error("Premium saved-card purchase error:", err.message);
      res.status(500).json({ error: "Failed to charge saved card" });
    }
  }

  // req.userId comes only from the verified JWT (middleware/auth.js) --
  // never from the request body/params -- so there is no field an
  // attacker could supply to target another driver's subscription here.
  static async cancelDriverPlan(req, res) {
    try {
      const subscription = await Subscription.cancelDriverPlan(req.userId);
      res.json({ success: true, subscription });
    } catch (err) {
      if (err.message === "NO_ACTIVE_SUBSCRIPTION") {
        return res.status(404).json({ error: "No active subscription to cancel." });
      }
      console.error("Driver plan cancellation error:", err.message);
      res.status(500).json({ error: "Failed to cancel subscription" });
    }
  }

  static async cancelPremium(req, res) {
    try {
      const subscription = await Subscription.cancelPremium(req.userId);
      res.json({ success: true, subscription });
    } catch (err) {
      if (err.message === "NO_ACTIVE_SUBSCRIPTION") {
        return res.status(404).json({ error: "No active subscription to cancel." });
      }
      console.error("Premium cancellation error:", err.message);
      res.status(500).json({ error: "Failed to cancel subscription" });
    }
  }
}

module.exports = SubscriptionController;
