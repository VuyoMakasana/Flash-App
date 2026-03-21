const BaseModel = require("./BaseModel");

class Tracking extends BaseModel {
  static async getOrderLocation(orderId) {
    const result = await this.query(
      `SELECT d.current_lat as lat, d.current_lng as lng, d.name as driver_name,
              d.vehicle_type, d.phone as driver_phone, d.profile_photo_url,
              o.status as order_status, o.dropoff_lat, o.dropoff_lng
       FROM orders o
       LEFT JOIN drivers d ON d.id = o.driver_id
       WHERE o.id = $1`,
      [orderId],
    );
    return result.rows[0];
  }
}

module.exports = Tracking;
