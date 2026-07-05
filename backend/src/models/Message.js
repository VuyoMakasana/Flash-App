const BaseModel = require("./BaseModel");

class Message extends BaseModel {
  static tableName = "messages";

  static async getMessages(orderId, userId, userRole) {
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

    const msgs = await this.query(
      `SELECT id, sender_id, sender_role, content, read_at, created_at
       FROM messages WHERE order_id=$1 ORDER BY created_at ASC`,
      [orderId],
    );

    await this.query(
      `UPDATE messages SET read_at=NOW()
       WHERE order_id=$1 AND sender_role != $2 AND read_at IS NULL`,
      [orderId, userRole],
    );

    return msgs.rows;
  }

  static async sendMessage(orderId, userId, userRole, content, io) {
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

    const msg = await this.query(
      `INSERT INTO messages (order_id, sender_id, sender_role, content)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [orderId, userId, userRole, content],
    );

    const newMsg = msg.rows[0];

    if (io) {
      io.to(`order:${orderId}`).emit("new_message", {
        orderId,
        message: newMsg,
      });

      const recipientId = userRole === "user" ? o.driver_id : o.user_id;
      if (recipientId) {
        const recipientRole = userRole === "user" ? "driver" : "user";
        io.to(`${recipientRole}:${recipientId}`).emit("new_message", {
          orderId,
          message: newMsg,
        });
      }
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
