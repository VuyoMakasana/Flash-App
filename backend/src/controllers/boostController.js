const Boost = require("../models/Boost");
const AdminAction = require("../models/AdminAction");

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
    const { productId, boostType } = req.body;
    if (!productId || !boostType) {
      return res.status(400).json({ error: "productId and boostType required" });
    }
    try {
      const result = await Boost.purchaseBoost(productId, boostType, req.userId);
      AdminAction.log(req.userId, "boost_purchase_initiated", "store_boosts", null, { productId, boostType });
      res.json(result);
    } catch (err) {
      if (err.message === "Invalid boost type" || err.message === "Product not found or inactive") {
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
      AdminAction.log(req.userId, "promotion_create", "store_promotions", promotion.id, { storeId, title, discountPercent });
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
