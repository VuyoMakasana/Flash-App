const BaseModel = require("./BaseModel");

class TrustedDriver extends BaseModel {
  static async getTrustedDrivers(userId) {
    const result = await this.query(
      `SELECT td.id, td.status, td.created_at,
              d.id as driver_id, d.name, d.rating, d.total_deliveries,
              d.vehicle_type, d.profile_photo_url, d.is_online,
              EXISTS(
                SELECT 1 FROM orders o
                WHERE o.driver_id = d.id
                  AND o.status IN ('driver_assigned','en_route','picked_up')
              ) as is_busy
       FROM trusted_drivers td
       JOIN drivers d ON d.id = td.driver_id
       WHERE td.user_id = $1 AND td.status = 'accepted'
       ORDER BY td.created_at DESC`,
      [userId],
    );
    return result.rows;
  }

  static async getPendingRequests(userId) {
    const result = await this.query(
      `SELECT td.id, td.status, td.created_at,
              d.id as driver_id, d.name, d.rating, d.vehicle_type
       FROM trusted_drivers td
       JOIN drivers d ON d.id = td.driver_id
       WHERE td.user_id = $1 AND td.status = 'pending'`,
      [userId],
    );
    return result.rows;
  }

  static async sendTrustRequest(userId, driverId, io) {
    const driver = await this.query(
      "SELECT id, name FROM drivers WHERE id=$1 AND status='approved'",
      [driverId],
    );

    if (!driver.rows.length) {
      throw new Error("Driver not found");
    }

    const result = await this.query(
      `INSERT INTO trusted_drivers (user_id, driver_id, status)
       VALUES ($1, $2, 'pending')
       ON CONFLICT (user_id, driver_id) DO UPDATE SET status='pending', updated_at=NOW()
       RETURNING *`,
      [userId, driverId],
    );

    if (io) {
      io.to(`driver:${driverId}`).emit("trust_request", {
        type: "trust_request",
        requestId: result.rows[0].id,
        userId: userId,
        message: "A customer wants to add you as a trusted driver",
      });
    }

    return result.rows[0];
  }

  static async removeTrustedDriver(userId, driverId) {
    await this.query(
      "DELETE FROM trusted_drivers WHERE user_id=$1 AND driver_id=$2",
      [userId, driverId],
    );
  }

  static async getDriverRequests(driverId) {
    const result = await this.query(
      `SELECT td.id, td.status, td.created_at,
              u.id as user_id, u.name as user_name
       FROM trusted_drivers td
       JOIN users u ON u.id = td.user_id
       WHERE td.driver_id = $1 AND td.status = 'pending'
       ORDER BY td.created_at DESC`,
      [driverId],
    );
    return result.rows;
  }

  static async respondToRequest(requestId, driverId, action, io) {
    const newStatus = action === "accept" ? "accepted" : "declined";
    const result = await this.query(
      `UPDATE trusted_drivers SET status=$1, updated_at=NOW()
       WHERE id=$2 AND driver_id=$3
       RETURNING *`,
      [newStatus, requestId, driverId],
    );

    if (!result.rows.length) {
      throw new Error("Request not found");
    }

    if (io) {
      io.to(`user:${result.rows[0].user_id}`).emit("trust_response", {
        driverId: driverId,
        status: newStatus,
        message:
          action === "accept"
            ? "A driver accepted your trusted driver request!"
            : "A driver declined your trusted driver request.",
      });
    }

    return { success: true, status: newStatus };
  }

  static async removeSelf(driverId, userId) {
    await this.query(
      "DELETE FROM trusted_drivers WHERE driver_id=$1 AND user_id=$2",
      [driverId, userId],
    );
  }

  static async checkDriverStatus(userId, driverId) {
    const result = await this.query(
      `SELECT d.id, d.name, d.is_online, d.rating, d.total_deliveries,
              d.vehicle_type, d.profile_photo_url,
              td.status as trust_status,
              EXISTS(
                SELECT 1 FROM orders o
                WHERE o.driver_id = d.id
                  AND o.status IN ('driver_assigned','en_route','picked_up')
              ) as is_busy
       FROM drivers d
       LEFT JOIN trusted_drivers td
         ON td.driver_id = d.id AND td.user_id = $1
       WHERE d.id = $2`,
      [userId, driverId],
    );
    return result.rows[0];
  }
}

module.exports = TrustedDriver;
