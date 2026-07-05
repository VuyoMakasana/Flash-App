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
}

module.exports = SosAlert;
