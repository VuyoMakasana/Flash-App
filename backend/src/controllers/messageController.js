const Message = require("../models/Message");

class MessageController {
  static async getMessages(req, res) {
    const { orderId } = req.params;
    try {
      const messages = await Message.getMessages(
        orderId,
        req.userId,
        req.userRole,
      );
      res.json({ messages });
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
}

module.exports = MessageController;
