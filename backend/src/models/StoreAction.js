const BaseModel = require("./BaseModel");

// Store-scoped audit log (docs/audits/FLASH_STORE_ADMIN_DESIGN.md §5.4) —
// the store-portal equivalent of AdminAction, structurally separate from
// admin_actions since the actor identity space is disjoint (store_users.id,
// not admins.id). Unlike admin_actions, every row also carries store_id
// directly, so a future dispute ("did this Store Manager touch an order
// that wasn't theirs") is answerable from the log itself, not just the actor.
class StoreAction extends BaseModel {
  static async log(storeUserId, storeId, actionType, targetTable = null, targetId = null, metadata = null) {
    try {
      await this.query(
        `INSERT INTO store_actions (store_user_id, store_id, action_type, target_table, target_id, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [storeUserId, storeId, actionType, targetTable, targetId, metadata ? JSON.stringify(metadata) : null],
      );
    } catch (err) {
      console.error("[StoreAction] log error:", err.message);
    }
  }

  static async getRecent(storeId, limit = 100) {
    const result = await this.query(
      `SELECT sa.*, su.name as store_user_name, su.email as store_user_email
       FROM store_actions sa
       JOIN store_users su ON su.id = sa.store_user_id
       WHERE sa.store_id = $1
       ORDER BY sa.created_at DESC LIMIT $2`,
      [storeId, limit],
    );
    return result.rows;
  }
}

module.exports = StoreAction;
