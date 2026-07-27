const Return = require("../models/Return");
const AdminAction = require("../models/AdminAction");

class ReturnController {
  static async requestReturn(req, res) {
    const { orderId } = req.params;
    const { items, reason } = req.body;
    const io = req.app.get("io");

    try {
      const returnRequest = await Return.requestReturn(
        orderId,
        req.userId,
        items,
        reason,
        io,
      );
      res.status(201).json({ returnRequest });
    } catch (err) {
      const clientErrors = [
        "Order not found",
        "Not your order",
        "Can only return delivered orders",
        "Return eligibility cannot be verified for this order",
        "At least one item must be selected for return",
        "One or more selected items do not belong to this order",
        "Quantity returned must be a positive whole number",
        "Cannot return more than the originally purchased quantity",
      ];
      // Startswith, not an exact string in the array above — this message
      // embeds ELIGIBILITY_WINDOW_HOURS (Return.js), so an exact match would
      // silently break again if that constant ever changes.
      if (clientErrors.includes(err.message) || err.message.startsWith("Returns open")) {
        return res.status(400).json({ error: err.message });
      }
      if (err.message === "Return already requested") {
        return res.status(409).json({ error: err.message });
      }
      if (err.message.startsWith("Selected items must total at least")) {
        return res.status(400).json({ error: err.message });
      }
      console.error("[Return] requestReturn error:", err.message);
      res.status(500).json({ error: "Failed to request return" });
    }
  }

  static async getPendingReturns(req, res) {
    try {
      const returns = await Return.getPendingForAdmin();
      res.json({ returns });
    } catch (err) {
      console.error("[Return] getPendingReturns error:", err.message);
      res.status(500).json({ error: "Failed to fetch pending returns" });
    }
  }

  static async getCredits(req, res) {
    try {
      const credits = await Return.getCredits(req.userId);
      res.json(credits);
    } catch (err) {
      console.error("[Return] getCredits error:", err.message);
      res.status(500).json({ error: "Failed to fetch store credits" });
    }
  }

  static async getUserReturns(req, res) {
    try {
      const returns = await Return.getUserReturns(req.userId);
      res.json({ returns });
    } catch (err) {
      console.error("[Return] getUserReturns error:", err.message);
      res.status(500).json({ error: "Failed to fetch returns" });
    }
  }

  static async approveReturn(req, res) {
    const { returnId } = req.params;
    try {
      const result = await Return.approveReturn(returnId, req.userId);
      AdminAction.log(req.userId, "return_approve", "return_requests", returnId);
      res.json({ success: true, ...result });
    } catch (err) {
      if (err.message === "Return not found") {
        return res.status(404).json({ error: "Return not found" });
      }
      if (err.message === "Return request is not awaiting approval") {
        return res.status(409).json({ error: err.message });
      }
      console.error("[Return] approveReturn error:", err.message);
      res.status(500).json({ error: "Failed to approve return" });
    }
  }

  static async rejectReturn(req, res) {
    const { returnId } = req.params;
    const { rejectionReason } = req.body;
    try {
      const result = await Return.rejectReturn(returnId, req.userId, rejectionReason);
      AdminAction.log(req.userId, "return_reject", "return_requests", returnId, { rejectionReason: rejectionReason || null });
      res.json({ success: true, returnRequest: result });
    } catch (err) {
      if (err.message === "Return not found") {
        return res.status(404).json({ error: "Return not found" });
      }
      if (err.message === "Return request is not in a rejectable state") {
        return res.status(409).json({ error: err.message });
      }
      console.error("[Return] rejectReturn error:", err.message);
      res.status(500).json({ error: "Failed to reject return" });
    }
  }

  static async finalizeRefund(req, res) {
    const { returnId } = req.params;
    try {
      const result = await Return.finalizeRefund(returnId, req.userId);
      AdminAction.log(req.userId, "return_finalize_refund", "return_requests", returnId);
      res.json({ success: true, ...result });
    } catch (err) {
      if (err.message === "Return not found") {
        return res.status(404).json({ error: "Return not found" });
      }
      if (
        err.message === "Return request is not awaiting final review" ||
        err.message === "Reverse-delivery order has not been completed yet"
      ) {
        return res.status(409).json({ error: err.message });
      }
      console.error("[Return] finalizeRefund error:", err.message);
      res.status(500).json({ error: "Failed to finalize refund" });
    }
  }
}

module.exports = ReturnController;
