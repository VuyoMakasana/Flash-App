const BaseModel = require("./BaseModel");

// §2.7 audit — chat block. A one-directional "don't pair us again" record,
// scoped to whichever order the block was raised from, but enforced
// globally going forward (not just for that one order) — see
// autoMatchService.js and Driver.getNearby() for the two real enforcement
// points. Deliberately its own small table rather than overloading
// trusted_drivers (which already means the opposite thing — a customer
// requesting a preferred driver again).
class UserBlock extends BaseModel {
  static tableName = "user_blocks";

  // The blocked party is always derived from the order server-side (never
  // client-supplied) — same IDOR-safe pattern as everything else in
  // Message.js. Throws the same "Order not found"/"Access denied" errors
  // messageController.js already knows how to map to HTTP responses.
  static async blockOtherPartyInOrder(orderId, callerId, callerRole) {
    const order = await this.query(
      "SELECT user_id, driver_id FROM orders WHERE id=$1",
      [orderId],
    );
    if (!order.rows.length) {
      throw new Error("Order not found");
    }

    const o = order.rows[0];
    const allowed =
      (callerRole === "user" && o.user_id === callerId) ||
      (callerRole === "driver" && o.driver_id === callerId);
    if (!allowed) {
      throw new Error("Access denied");
    }

    const blockedId = callerRole === "user" ? o.driver_id : o.user_id;
    const blockedRole = callerRole === "user" ? "driver" : "user";
    if (!blockedId) {
      throw new Error("No other party on this order to block");
    }

    await this.query(
      `INSERT INTO user_blocks (blocker_id, blocker_role, blocked_id, blocked_role)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (blocker_id, blocked_id) DO NOTHING`,
      [callerId, callerRole, blockedId, blockedRole],
    );

    return { blockedId, blockedRole };
  }

  // Every driver id blocked *by* this user, or that has blocked this user —
  // either direction should prevent future pairing. Used by
  // autoMatchService.js (fleet auto-assignment) and Driver.getNearby()
  // (pick-a-driver mode) to exclude drivers from a specific customer's
  // matching/results.
  static async getBlockedDriverIdsForUser(userId) {
    const result = await this.query(
      `SELECT blocked_id AS id FROM user_blocks WHERE blocker_id = $1 AND blocker_role = 'user' AND blocked_role = 'driver'
       UNION
       SELECT blocker_id AS id FROM user_blocks WHERE blocked_id = $1 AND blocked_role = 'user' AND blocker_role = 'driver'`,
      [userId],
    );
    return result.rows.map((r) => r.id);
  }
}

module.exports = UserBlock;
