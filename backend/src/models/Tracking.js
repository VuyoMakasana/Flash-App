const BaseModel = require("./BaseModel");

class Tracking extends BaseModel {
  static async getOrderLocation(orderId, requesterId, requesterRole) {
    const result = await this.query(
      `SELECT d.current_lat as lat, d.current_lng as lng, d.name as driver_name,
              d.vehicle_type, d.phone as driver_phone, d.profile_photo_url,
              o.status as order_status, o.dropoff_lat, o.dropoff_lng,
              o.user_id, o.driver_id
       FROM orders o
       LEFT JOIN drivers d ON d.id = o.driver_id
       WHERE o.id = $1`,
      [orderId],
    );
    const row = result.rows[0];
    if (!row) return null;

    if (requesterRole === "admin") return row;
    if (requesterRole === "user" && String(row.user_id) === String(requesterId)) return row;
    if (requesterRole === "driver" && String(row.driver_id) === String(requesterId)) return row;

    return null;
  }
}

module.exports = Tracking;
