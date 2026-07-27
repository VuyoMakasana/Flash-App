'use strict';

const BaseModel = require('./BaseModel');

class SosAlert extends BaseModel {
  static async create(orderId, triggeredByRole, triggeredById, lat, lng) {
    const result = await this.query(
      `INSERT INTO sos_alerts (order_id, triggered_by_role, triggered_by_id, lat, lng)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [orderId, triggeredByRole, triggeredById, lat ?? null, lng ?? null],
    );
    return result.rows[0];
  }

  // Phase 3 (ADMIN_PANEL_AUDIT_AND_VISION.md §1.4/§3) — before this, an SOS
  // alert only ever reached a live Socket.io connection to the 'admin' room;
  // if nobody had the panel open at that exact moment, the alert was gone
  // from any accessible UI or API forever (still in the DB, but nothing
  // could read it back out). status filters the same way order/return
  // queues already do elsewhere in this codebase.
  static async getAll(status = null) {
    let query = 'SELECT * FROM sos_alerts';
    if (status === 'unacknowledged') query += ' WHERE acknowledged_at IS NULL';
    else if (status === 'acknowledged') query += ' WHERE acknowledged_at IS NOT NULL';
    query += ' ORDER BY created_at DESC';
    const result = await this.query(query);
    return result.rows;
  }

  // WHERE acknowledged_at IS NULL makes this idempotent against a double
  // click/race (two admins acknowledging the same alert at once) -- the
  // second call's UPDATE matches zero rows and returns null, rather than
  // silently overwriting who actually acknowledged it first.
  static async acknowledge(alertId, adminId) {
    const result = await this.query(
      `UPDATE sos_alerts SET acknowledged_at = NOW(), acknowledged_by = $2
       WHERE id = $1 AND acknowledged_at IS NULL
       RETURNING *`,
      [alertId, adminId],
    );
    return result.rows[0] || null;
  }
}

module.exports = SosAlert;
