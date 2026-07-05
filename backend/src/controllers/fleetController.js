const Fleet = require("../models/Fleet");
const {
  runFleetIntelligence,
} = require("../services/fleetIntelligenceService");

class FleetController {
  static async getClusters(req, res) {
    try {
      const clusters = await Fleet.getClusters();
      res.json({ clusters });
    } catch (err) {
      console.error("[Fleet] getClusters error:", err.message);
      res.status(500).json({ error: "Failed to fetch clusters" });
    }
  }

  static async runIntelligence(req, res) {
    const io = req.app.get("io");
    const clusters = await runFleetIntelligence(io);
    res.json({ success: true, clustersFound: clusters.length, clusters });
  }
}

module.exports = FleetController;
