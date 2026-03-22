const Sizing = require("../models/Sizing");

class SizingController {
  static async getMeasurementGuide(req, res) {
    const guide = Sizing.getMeasurementGuide();
    res.json({ guide });
  }

  static async getSizeProfile(req, res) {
    try {
      const profile = await Sizing.getSizeProfile(req.userId);
      res.json({ profile: profile || null });
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch size profile" });
    }
  }

  static async saveSizeProfile(req, res) {
    try {
      const profile = await Sizing.saveSizeProfile(req.userId, req.body);
      res.json({ profile });
    } catch (err) {
      if (err.message.includes("must be between")) {
        return res.status(400).json({ error: err.message });
      }
      res.status(500).json({ error: "Failed to save size profile" });
    }
  }

  static async getRecommendation(req, res) {
    const { storeId, category } = req.params;
    try {
      const recommendation = await Sizing.getRecommendation(
        req.userId,
        storeId,
        category,
      );
      res.json(recommendation);
    } catch (err) {
      console.error("[Sizing] Error:", err.message);
      res.json({
        recommendation: null,
        fallback: true,
        message: "Size recommendation temporarily unavailable.",
      });
    }
  }

  static async seedMappings(req, res) {
    const { storeId, brandName, category, mappings } = req.body;
    if (!storeId || !brandName || !category || !Array.isArray(mappings)) {
      return res
        .status(400)
        .json({
          error: "storeId, brandName, category and mappings[] required",
        });
    }
    try {
      const seeded = await Sizing.seedMappings(
        storeId,
        brandName,
        category,
        mappings,
      );
      res.json({
        success: true,
        message: `${seeded} size mappings saved for ${brandName}`,
      });
    } catch (err) {
      res.status(500).json({ error: "Failed to seed size mappings" });
    }
  }
}

module.exports = SizingController;
