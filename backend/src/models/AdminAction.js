const BaseModel = require("./BaseModel");

// Admin action audit log (Phase 0, docs/audits/ADMIN_PANEL_AUDIT_AND_VISION.md).
// Append-only, same shape as driver_wallet_ledger — one row per real
// admin-mutating action. Logged as a best-effort call after the action's own
// transaction has already committed (same convention as notifyOrderStatusChange
// / socket emits elsewhere in this codebase) — a lost audit-log write must
// never roll back or block the real action it's describing.
class AdminAction extends BaseModel {
  static async log(adminId, actionType, targetTable = null, targetId = null, metadata = null) {
    try {
      await this.query(
        `INSERT INTO admin_actions (admin_id, action_type, target_table, target_id, metadata)
         VALUES ($1, $2, $3, $4, $5)`,
        [adminId, actionType, targetTable, targetId, metadata ? JSON.stringify(metadata) : null],
      );
    } catch (err) {
      console.error("[AdminAction] log error:", err.message);
    }
  }

  static async getRecent(limit = 100) {
    const result = await this.query(
      `SELECT aa.*, a.name as admin_name, a.email as admin_email
       FROM admin_actions aa
       JOIN admins a ON a.id = aa.admin_id
       ORDER BY aa.created_at DESC LIMIT $1`,
      [limit],
    );
    return result.rows;
  }
}

module.exports = AdminAction;
