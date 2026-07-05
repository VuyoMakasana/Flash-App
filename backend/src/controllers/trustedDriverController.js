const TrustedDriver = require("../models/TrustedDriver");

class TrustedDriverController {
  static async getTrustedDrivers(req, res) {
    try {
      const trustedDrivers = await TrustedDriver.getTrustedDrivers(req.userId);
      res.json({ trustedDrivers });
    } catch (err) {
      console.error("[TrustedDriver] getTrustedDrivers error:", err.message);
      res.status(500).json({ error: "Failed to fetch trusted drivers" });
    }
  }

  static async getPendingRequests(req, res) {
    try {
      const pending = await TrustedDriver.getPendingRequests(req.userId);
      res.json({ pending });
    } catch (err) {
      console.error("[TrustedDriver] getPendingRequests error:", err.message);
      res.status(500).json({ error: "Failed to fetch pending requests" });
    }
  }

  static async sendTrustRequest(req, res) {
    const { driverId } = req.params;
    const io = req.app.get("io");

    try {
      const request = await TrustedDriver.sendTrustRequest(
        req.userId,
        driverId,
        io,
      );
      res.status(201).json({ request });
    } catch (err) {
      if (err.message === "Driver not found") {
        return res.status(404).json({ error: "Driver not found" });
      }
      console.error("[TrustedDriver] sendTrustRequest error:", err.message);
      res.status(500).json({ error: "Failed to send trust request" });
    }
  }

  static async removeTrustedDriver(req, res) {
    const { driverId } = req.params;
    try {
      await TrustedDriver.removeTrustedDriver(req.userId, driverId);
      res.json({ success: true });
    } catch (err) {
      console.error("[TrustedDriver] removeTrustedDriver error:", err.message);
      res.status(500).json({ error: "Failed to remove trusted driver" });
    }
  }

  static async getDriverRequests(req, res) {
    try {
      const requests = await TrustedDriver.getDriverRequests(req.userId);
      res.json({ requests });
    } catch (err) {
      console.error("[TrustedDriver] getDriverRequests error:", err.message);
      res.status(500).json({ error: "Failed to fetch requests" });
    }
  }

  static async respondToRequest(req, res) {
    const { requestId } = req.params;
    const { action } = req.body;
    const io = req.app.get("io");

    if (!["accept", "decline"].includes(action)) {
      return res
        .status(400)
        .json({ error: "action must be accept or decline" });
    }

    try {
      const result = await TrustedDriver.respondToRequest(
        requestId,
        req.userId,
        action,
        io,
      );
      res.json(result);
    } catch (err) {
      if (err.message === "Request not found") {
        return res.status(404).json({ error: "Request not found" });
      }
      console.error("[TrustedDriver] respondToRequest error:", err.message);
      res.status(500).json({ error: "Failed to respond to request" });
    }
  }

  static async removeSelf(req, res) {
    const { userId } = req.params;
    try {
      await TrustedDriver.removeSelf(req.userId, userId);
      res.json({ success: true });
    } catch (err) {
      console.error("[TrustedDriver] removeSelf error:", err.message);
      res.status(500).json({ error: "Failed to remove self" });
    }
  }

  static async checkDriverStatus(req, res) {
    const { driverId } = req.params;
    try {
      const driver = await TrustedDriver.checkDriverStatus(
        req.userId,
        driverId,
      );
      if (!driver) {
        return res.status(404).json({ error: "Driver not found" });
      }
      res.json({ driver });
    } catch (err) {
      console.error("[TrustedDriver] checkDriverStatus error:", err.message);
      res.status(500).json({ error: "Failed to check driver status" });
    }
  }
}

module.exports = TrustedDriverController;
