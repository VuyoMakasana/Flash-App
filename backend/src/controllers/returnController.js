const Return = require("../models/Return");

class ReturnController {
  static async requestReturn(req, res) {
    const { orderId } = req.params;
    const { reason } = req.body;
    const io = req.app.get("io");

    try {
      const returnRequest = await Return.requestReturn(
        orderId,
        req.userId,
        reason,
        io,
      );
      res.status(201).json({ returnRequest });
    } catch (err) {
      if (err.message === "Order not found") {
        return res.status(404).json({ error: "Order not found" });
      }
      if (err.message === "Can only return delivered orders") {
        return res.status(400).json({ error: err.message });
      }
      if (err.message === "Return already requested") {
        return res.status(409).json({ error: err.message });
      }
      res.status(500).json({ error: "Failed to request return" });
    }
  }

  static async pickupReturn(req, res) {
    const { returnId } = req.params;
    const io = req.app.get("io");

    try {
      const result = await Return.pickupReturn(returnId, req.userId, io);
      res.json(result);
    } catch (err) {
      console.error("Return pickup error:", err);
      res.status(500).json({ error: "Failed to process return pickup" });
    }
  }

  static async getCredits(req, res) {
    try {
      const credits = await Return.getCredits(req.userId);
      res.json(credits);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch store credits" });
    }
  }

  static async getUserReturns(req, res) {
    try {
      const returns = await Return.getUserReturns(req.userId);
      res.json({ returns });
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch returns" });
    }
  }

  static async approveReturn(req, res) {
    const { returnId } = req.params;
    try {
      const result = await Return.approveReturn(returnId, req.userId);
      res.json({ success: true, ...result });
    } catch (err) {
      if (err.message === "Return not found") {
        return res.status(404).json({ error: "Return not found" });
      }
      if (err.message === "Return request is not awaiting approval") {
        return res.status(409).json({ error: err.message });
      }
      res.status(500).json({ error: "Failed to approve return" });
    }
  }
}

module.exports = ReturnController;
