const BaseModel = require("./BaseModel");
const notificationService = require("../services/notificationService");
const UserBlock = require("./UserBlock");

// §2.2 audit — conversation lifecycle: chat had no cutoff at all tied to the
// order's own lifecycle, so a customer/driver pair could keep messaging
// indefinitely on an order finished months ago. A short grace window after
// the order actually ends (not an immediate hard cutoff) covers real
// post-delivery follow-up ("where did you leave it", wrong item, etc.)
// without leaving the conversation open forever. Read access (getMessages/
// getUnreadCount) is left ungated by this — history stays visible for
// dispute resolution even after closure; only *sending new messages* stops.
const CONVERSATION_CLOSURE_GRACE_HOURS = 24;

class Message extends BaseModel {
  static tableName = "messages";

  static _isConversationClosed(order) {
    if (!["delivered", "completed", "cancelled"].includes(order.status)) {
      return false;
    }
    const closedAt = order.delivered_at || order.updated_at;
    return new Date(closedAt).getTime() <
      Date.now() - CONVERSATION_CLOSURE_GRACE_HOURS * 60 * 60 * 1000;
  }

  static async getMessages(orderId, userId, userRole) {
    const order = await this.query(
      "SELECT user_id, driver_id, status, delivered_at, updated_at FROM orders WHERE id=$1",
      [orderId],
    );

    if (!order.rows.length) {
      throw new Error("Order not found");
    }

    const o = order.rows[0];
    const allowed =
      (userRole === "user" && o.user_id === userId) ||
      (userRole === "driver" && o.driver_id === userId);

    if (!allowed) {
      throw new Error("Access denied");
    }

    // Defensive cap — a single order's chat is naturally short-lived (tied
    // to one same-day delivery), so this is not expected to bind in normal
    // use, but an unbounded SELECT here had no floor against a pathological
    // volume of messages on one order. Returns the most recent 200,
    // re-sorted back to chronological order for display.
    const msgs = await this.query(
      `SELECT id, sender_id, sender_role, content, read_at, created_at FROM (
         SELECT id, sender_id, sender_role, content, read_at, created_at
         FROM messages WHERE order_id=$1
         ORDER BY created_at DESC
         LIMIT 200
       ) recent ORDER BY created_at ASC`,
      [orderId],
    );

    await this.query(
      `UPDATE messages SET read_at=NOW()
       WHERE order_id=$1 AND sender_role != $2 AND read_at IS NULL`,
      [orderId, userRole],
    );

    const otherPartyId = userRole === "user" ? o.driver_id : o.user_id;
    const blocked = otherPartyId ? await UserBlock.isBlockedPair(userId, otherPartyId) : false;

    return { messages: msgs.rows, closed: this._isConversationClosed(o), blocked };
  }

  static async sendMessage(orderId, userId, userRole, content, io) {
    const order = await this.query(
      "SELECT user_id, driver_id, status, delivered_at, updated_at FROM orders WHERE id=$1",
      [orderId],
    );

    if (!order.rows.length) {
      throw new Error("Order not found");
    }

    const o = order.rows[0];
    const allowed =
      (userRole === "user" && o.user_id === userId) ||
      (userRole === "driver" && o.driver_id === userId);

    if (!allowed) {
      throw new Error("Access denied");
    }

    // §2.7 audit — a block cuts off chat on this order *immediately*,
    // regardless of the order's own status/lifecycle-grace window below.
    // If someone blocks an abusive driver mid-delivery, that needs to stop
    // the harassment right now, not just prevent a repeat next time -- the
    // delivery itself is unaffected (this only ever gates messaging).
    const otherPartyId = userRole === "user" ? o.driver_id : o.user_id;
    if (otherPartyId && (await UserBlock.isBlockedPair(userId, otherPartyId))) {
      throw new Error("BLOCKED");
    }

    if (this._isConversationClosed(o)) {
      throw new Error("CONVERSATION_CLOSED");
    }

    const msg = await this.query(
      `INSERT INTO messages (order_id, sender_id, sender_role, content)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [orderId, userId, userRole, content],
    );

    const newMsg = msg.rows[0];
    const recipientId = userRole === "user" ? o.driver_id : o.user_id;
    const recipientRole = userRole === "user" ? "driver" : "user";

    if (io) {
      io.to(`order:${orderId}`).emit("new_message", {
        orderId,
        message: newMsg,
      });

      if (recipientId) {
        io.to(`${recipientRole}:${recipientId}`).emit("new_message", {
          orderId,
          message: newMsg,
        });
      }
    }

    // §2.2 audit — previously no push notification existed for a new
    // message at all, only the socket emit above. A recipient whose app is
    // backgrounded or killed (not connected to the socket) never learned a
    // message had arrived. Best-effort (notifyNewMessage catches its own
    // errors) — a push failure must never fail the send itself.
    if (recipientId) {
      notificationService.notifyNewMessage(recipientId, recipientRole, orderId, userRole, content);
    }

    return newMsg;
  }

  // Previously took no userId, so any authenticated user or driver could
  // query the unread count for any order — unlike getMessages/sendMessage,
  // which both verify the caller is actually party to the order.
  static async getUnreadCount(orderId, userId, userRole) {
    const order = await this.query(
      "SELECT user_id, driver_id FROM orders WHERE id=$1",
      [orderId],
    );

    if (!order.rows.length) {
      throw new Error("Order not found");
    }

    const o = order.rows[0];
    const allowed =
      (userRole === "user" && o.user_id === userId) ||
      (userRole === "driver" && o.driver_id === userId);

    if (!allowed) {
      throw new Error("Access denied");
    }

    const result = await this.query(
      `SELECT COUNT(*) as count FROM messages
       WHERE order_id=$1 AND sender_role != $2 AND read_at IS NULL`,
      [orderId, userRole],
    );
    return parseInt(result.rows[0].count);
  }
}

module.exports = Message;
