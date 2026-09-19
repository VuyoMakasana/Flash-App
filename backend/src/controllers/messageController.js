const Message = require("../models/Message");
const ChatReport = require("../models/ChatReport");
const UserBlock = require("../models/UserBlock");

class MessageController {
  static async getMessages(req, res) {
    const { orderId } = req.params;
    try {
      const result = await Message.getMessages(
        orderId,
        req.userId,
        req.userRole,
      );
      res.json(result);
    } catch (err) {
      if (err.message === "Order not found") {
        return res.status(404).json({ error: "Order not found" });
      }
      if (err.message === "Access denied") {
        return res.status(403).json({ error: "Access denied" });
      }
      console.error("[Message] getMessages error:", err.message);
      res.status(500).json({ error: "Failed to fetch messages" });
    }
  }

  static async sendMessage(req, res) {
    const { orderId } = req.params;
    const { content } = req.body;
    const io = req.app.get("io");

    if (!content?.trim()) {
      return res.status(400).json({ error: "Message content required" });
    }
    if (content.length > 500) {
      return res
        .status(400)
        .json({ error: "Message too long (max 500 chars)" });
    }

    try {
      const message = await Message.sendMessage(
        orderId,
        req.userId,
        req.userRole,
        content.trim(),
        io,
      );
      res.status(201).json({ message });
    } catch (err) {
      if (err.message === "Order not found") {
        return res.status(404).json({ error: "Order not found" });
      }
      if (err.message === "Access denied") {
        return res.status(403).json({ error: "Access denied" });
      }
      if (err.message === "BLOCKED") {
        return res.status(403).json({ error: "You can't message this person." });
      }
      if (err.message === "CONVERSATION_CLOSED") {
        return res.status(409).json({
          error: "This conversation has closed for this order. Contact support@flashdelivery.co.za if you still need help.",
        });
      }
      console.error("[Message] sendMessage error:", err.message);
      res.status(500).json({ error: "Failed to send message" });
    }
  }

  static async getUnreadCount(req, res) {
    const { orderId } = req.params;
    try {
      const unread = await Message.getUnreadCount(orderId, req.userId, req.userRole);
      res.json({ unread });
    } catch (err) {
      if (err.message === "Order not found") {
        return res.status(404).json({ error: "Order not found" });
      }
      if (err.message === "Access denied") {
        return res.status(403).json({ error: "Access denied" });
      }
      console.error("[Message] getUnreadCount error:", err.message);
      res.status(500).json({ error: "Failed to fetch unread count" });
    }
  }

  // §2.7 audit — report the other party in this order's conversation.
  // Never auto-actions anyone; just creates a real record for an admin to
  // review (AdminJS resource, adminPanel.js).
  static async reportUser(req, res) {
    const { orderId } = req.params;
    const { reason, messageId } = req.body;

    if (!reason?.trim()) {
      return res.status(400).json({ error: "A reason is required" });
    }
    if (reason.length > 500) {
      return res.status(400).json({ error: "Reason too long (max 500 chars)" });
    }

    try {
      const report = await ChatReport.create(
        orderId,
        req.userId,
        req.userRole,
        reason.trim(),
        messageId || null,
      );
      res.status(201).json({ report });
    } catch (err) {
      if (err.message === "Order not found") {
        return res.status(404).json({ error: "Order not found" });
      }
      if (err.message === "Access denied") {
        return res.status(403).json({ error: "Access denied" });
      }
      if (err.message === "No other party on this order to report") {
        return res.status(409).json({ error: err.message });
      }
      console.error("[Message] reportUser error:", err.message);
      res.status(500).json({ error: "Failed to submit report" });
    }
  }

  // §2.7 audit — block the other party in this order's conversation from
  // being paired with the caller again. Only prevents *future* pairing
  // (autoMatchService.js, Driver.getNearby) -- can't retroactively un-pair
  // an order already in progress.
  static async blockUser(req, res) {
    const { orderId } = req.params;

    try {
      const result = await UserBlock.blockOtherPartyInOrder(orderId, req.userId, req.userRole);
      res.status(201).json({ blocked: true, ...result });
    } catch (err) {
      if (err.message === "Order not found") {
        return res.status(404).json({ error: "Order not found" });
      }
      if (err.message === "Access denied") {
        return res.status(403).json({ error: "Access denied" });
      }
      if (err.message === "No other party on this order to block") {
        return res.status(409).json({ error: err.message });
      }
      console.error("[Message] blockUser error:", err.message);
      res.status(500).json({ error: "Failed to block user" });
    }
  }
}

module.exports = MessageController;
