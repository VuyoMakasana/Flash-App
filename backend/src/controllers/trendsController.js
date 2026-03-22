const Trends = require("../models/Trends");

class TrendsController {
  static async getCityTrends(req, res) {
    try {
      const trends = await Trends.getCityTrends();
      res.json({ trends });
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch city trends" });
    }
  }

  static async getCategoryTrends(req, res) {
    const { days = 7 } = req.query;
    try {
      const trends = await Trends.getCategoryTrends(days);
      res.json({ trends, period_days: parseInt(days) });
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch category trends" });
    }
  }

  static async getPriceTrends(req, res) {
    try {
      const trends = await Trends.getPriceTrends();
      res.json({ trends });
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch price trends" });
    }
  }

  static async getTopProducts(req, res) {
    const { days = 30, limit = 10 } = req.query;
    try {
      const products = await Trends.getTopProducts(days, limit);
      res.json({ products, period_days: parseInt(days) });
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch top products" });
    }
  }

  static async recordBrowsingEvent(req, res) {
    const { productId, category, lat, lng, city, durationSeconds } = req.body;
    try {
      await Trends.recordBrowsingEvent(req.userId, {
        productId,
        category,
        lat,
        lng,
        city,
        durationSeconds,
      });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to record browse event" });
    }
  }
}

module.exports = TrendsController;
