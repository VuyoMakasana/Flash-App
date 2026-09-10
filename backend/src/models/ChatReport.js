const BaseModel = require("./BaseModel");

// §2.7 audit — chat report. Reporting never auto-suspends or auto-actions
// anyone — it only ever creates a real, investigatable record for an admin
// to review (same "a human confirms before any consequence" principle as
// the driver-fraud work in §2.4). The AdminJS resource (adminPanel.js) is
// where an admin actually resolves one.
class ChatReport extends BaseModel {
  static tableName = "chat_reports";

  // The reported party and their role are always derived from the order
  // server-side (never client-supplied) — same IDOR-safe pattern as
  // everything else in Message.js. messageId is optional (reporting the
  // other party generally, not one specific message).
  static async create(orderId, reporterId, reporterRole, reason, messageId = null) {
    const order = await this.query(
      "SELECT user_id, driver_id FROM orders WHERE id=$1",
      [orderId],
    );
    if (!order.rows.length) {
      throw new Error("Order not found");
    }

    const o = order.rows[0];
    const allowed =
      (reporterRole === "user" && o.user_id === reporterId) ||
      (reporterRole === "driver" && o.driver_id === reporterId);
    if (!allowed) {
      throw new Error("Access denied");
    }

    const reportedId = reporterRole === "user" ? o.driver_id : o.user_id;
    const reportedRole = reporterRole === "user" ? "driver" : "user";
    if (!reportedId) {
      throw new Error("No other party on this order to report");
    }

    // If a messageId was given, confirm it's real and belongs to this order
    // — otherwise silently drop it rather than 500 on a stale/bad client id.
    let validMessageId = null;
    if (messageId) {
      const msg = await this.query(
        "SELECT id FROM messages WHERE id=$1 AND order_id=$2",
        [messageId, orderId],
      );
      if (msg.rows.length) validMessageId = messageId;
    }

    const result = await this.query(
      `INSERT INTO chat_reports (order_id, reporter_id, reporter_role, reported_id, reported_role, message_id, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, created_at`,
      [orderId, reporterId, reporterRole, reportedId, reportedRole, validMessageId, reason],
    );

    return result.rows[0];
  }

  // Admin review — status moves from 'pending' to one of
  // reviewed/actioned/dismissed, with optional notes. Only actionable while
  // genuinely still pending, same guard shape as SosAlert.acknowledge.
  static async resolve(reportId, adminId, status, notes) {
    const result = await this.query(
      `UPDATE chat_reports
       SET status = $2, admin_notes = $3, reviewed_by = $4, reviewed_at = NOW()
       WHERE id = $1 AND status = 'pending'
       RETURNING *`,
      [reportId, status, notes || null, adminId],
    );
    return result.rows[0] || null;
  }
}

module.exports = ChatReport;
