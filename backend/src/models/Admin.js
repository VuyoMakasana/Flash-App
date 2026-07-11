const BaseModel = require("./BaseModel");
const s3Service = require("../services/s3Service");

class Admin extends BaseModel {
  static async getDrivers(status = null) {
    const query = status
      ? "SELECT id, name, email, phone, vehicle_type, status, created_at FROM drivers WHERE status=$1 ORDER BY created_at DESC"
      : "SELECT id, name, email, phone, vehicle_type, status, created_at FROM drivers ORDER BY created_at DESC";

    const result = await this.query(query, status ? [status] : []);
    return result.rows;
  }

  static async getDriverById(driverId) {
    const driver = await this.query("SELECT * FROM drivers WHERE id=$1", [
      driverId,
    ]);
    if (!driver.rows.length) return null;

    // H-access-audit FIX: this used to SELECT * and return the stored
    // file_url straight through, which (before the upload-side fix) was a
    // permanently-valid Cloudinary URL — so every admin API call handed out
    // a link that never expired. Now file_url is never selected; a fresh,
    // short-lived signed URL is generated per document at request time
    // instead. Documents uploaded before this fix have no public_id and
    // get file_url: null — they'll need to be re-uploaded to be viewable.
    const docs = await this.query(
      `SELECT id, driver_id, document_type, file_name, verified, verified_at,
              verified_by, notes, uploaded_at, public_id, resource_type
       FROM driver_documents WHERE driver_id=$1`,
      [driverId],
    );
    const documents = await Promise.all(
      docs.rows.map(async ({ public_id, resource_type, ...doc }) => ({
        ...doc,
        file_url: public_id
          ? await s3Service.getSignedUrl(public_id, resource_type || "image")
          : null,
      })),
    );
    const { password_hash, ...safeDriver } = driver.rows[0];
    return { driver: safeDriver, documents };
  }

  static async updateDriverStatus(driverId, status) {
    await this.query(
      "UPDATE drivers SET status=$1, updated_at=NOW() WHERE id=$2",
      [status, driverId],
    );
  }

  static async getOrders() {
    const result = await this.query(
      `SELECT o.id, o.order_number, o.status, o.total, o.payment_method, o.created_at,
              u.name as user_name, d.name as driver_name
       FROM orders o
       LEFT JOIN users u ON u.id = o.user_id
       LEFT JOIN drivers d ON d.id = o.driver_id
       ORDER BY o.created_at DESC LIMIT 100`,
    );
    return result.rows;
  }

  static async getStats() {
    const [users, drivers, orders, revenue] = await Promise.all([
      this.query("SELECT COUNT(*) FROM users"),
      this.query("SELECT COUNT(*) FROM drivers WHERE status='approved'"),
      this.query("SELECT COUNT(*) FROM orders"),
      this.query(
        "SELECT COALESCE(SUM(total),0) as total FROM orders WHERE payment_status='paid'",
      ),
    ]);

    return {
      totalUsers: parseInt(users.rows[0].count),
      approvedDrivers: parseInt(drivers.rows[0].count),
      totalOrders: parseInt(orders.rows[0].count),
      totalRevenue: parseFloat(revenue.rows[0].total),
    };
  }
}

module.exports = Admin;
