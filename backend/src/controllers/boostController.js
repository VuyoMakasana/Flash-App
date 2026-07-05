const Boost = require("../models/Boost");

class BoostController {
  static async getActiveBoosts(req, res) {
    try {
      const boosts = await Boost.getActiveBoosts();
      res.json({ boosts });
    } catch (err) {
      console.error("[Boost] getActiveBoosts error:", err.message);
      res.status(500).json({ error: "Failed to fetch boosts" });
    }
  }

  static async getPromotions(req, res) {
    try {
      const promotions = await Boost.getPromotions();
      res.json({ promotions });
    } catch (err) {
      console.error("[Boost] getPromotions error:", err.message);
      res.status(500).json({ error: "Failed to fetch promotions" });
    }
  }

  static async purchaseBoost(req, res) {
    const { storeId, storeName, boostType } = req.body;
    try {
      const boost = await Boost.purchaseBoost(storeId, storeName, boostType);
      res.status(201).json(boost);
    } catch (err) {
      if (err.message === "Invalid boost type") {
        return res.status(400).json({ error: err.message });
      }
      console.error("[Boost] purchaseBoost error:", err.message);
      res.status(500).json({ error: "Failed to create boost" });
    }
  }

  static async createPromotion(req, res) {
    const { storeId, title, description, discountPercent, durationDays } =
      req.body;
    if (!storeId || !title) {
      return res.status(400).json({ error: "storeId and title required" });
    }

    try {
      const promotion = await Boost.createPromotion(
        storeId,
        title,
        description,
        discountPercent,
        durationDays,
      );
      res.status(201).json({ promotion });
    } catch (err) {
      console.error("[Boost] createPromotion error:", err.message);
      res.status(500).json({ error: "Failed to create promotion" });
    }
  }

  static async getPlans(req, res) {
    const plans = Boost.getPlans();
    res.json({ plans });
  }
}

module.exports = BoostController;
