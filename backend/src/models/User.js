const BaseModel = require("./BaseModel");
const bcrypt = require("bcryptjs");

class User extends BaseModel {
  static tableName = "users";

  static async findByEmail(email) {
    const result = await this.query("SELECT * FROM users WHERE email = $1", [
      email,
    ]);
    return result.rows[0];
  }

  static async create(userData) {
    const { name, email, password, phone } = userData;
    const password_hash = await bcrypt.hash(password, 12);

    return await super.create(this.tableName, {
      name,
      email,
      password_hash,
      phone: phone || null,
      terms_accepted: false,
    });
  }

  static async verifyPassword(email, password) {
    const user = await this.findByEmail(email);
    if (!user) return null;

    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) return null;

    const { password_hash, ...safeUser } = user;
    return safeUser;
  }

  static async updateProfile(userId, data) {
    const { name, phone, address } = data;
    return await super.update(this.tableName, userId, { name, phone, address });
  }

  static async acceptTerms(userId) {
    return await super.update(this.tableName, userId, {
      terms_accepted: true,
      terms_accepted_at: new Date(),
    });
  }

  static async getOrders(userId, page = 1, limit = 20) {
    const offset = (page - 1) * limit;
    const sql = `
      SELECT o.*, d.name as driver_name, d.phone as driver_phone,
             d.vehicle_type as driver_vehicle, d.profile_photo_url as driver_photo,
             d.rating as driver_rating,
             d.current_lat as driver_lat, d.current_lng as driver_lng,
             json_agg(json_build_object(
               'id', oi.id, 'product_id', oi.product_id, 'product_name', oi.product_name,
               'size', oi.size, 'quantity', oi.quantity, 'unit_price', oi.unit_price, 
               'total_price', oi.total_price
             )) as items
      FROM orders o
      LEFT JOIN drivers d ON d.id = o.driver_id
      LEFT JOIN order_items oi ON oi.order_id = o.id
      WHERE o.user_id = $1
      GROUP BY o.id, d.id
      ORDER BY o.created_at DESC
      LIMIT $2 OFFSET $3
    `;
    const result = await this.query(sql, [userId, limit, offset]);
    return result.rows;
  }
}

module.exports = User;
