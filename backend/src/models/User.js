const BaseModel = require("./BaseModel");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

class User extends BaseModel {
  static tableName = "users";

  static async findByEmail(email) {
    const result = await this.query("SELECT * FROM users WHERE email = $1", [
      email,
    ]);
    return result.rows[0];
  }

  static async create(userData) {
    const { name, email, password, phone, date_of_birth } = userData;
    const password_hash = await bcrypt.hash(password, 12);
    return await super.create(this.tableName, {
      name, email, password_hash, phone: phone || null, terms_accepted: false,
      date_of_birth: date_of_birth || null,
    });
  }

  // Creates a user who registered via Apple Sign In.
  // The placeholder password is cryptographically random — they never use it.
  // apple_id (Apple's sub) is stored so we can find their account on every future sign-in.
  static async createWithApple({ name, email, appleId, placeholderPassword, emailVerified = false }) {
    const password_hash = await bcrypt.hash(placeholderPassword, 12);
    return await super.create(this.tableName, {
      name,
      email,
      password_hash,
      apple_id:       appleId,
      email_verified: emailVerified,
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
    const { name, phone, address, email } = data;

    const payload = { name, phone, address };

    if (email) {
      const existing = await this.query(
        "SELECT id FROM users WHERE email = $1 AND id != $2",
        [email, userId],
      );
      if (existing.rows.length) {
        throw new Error("Email already in use");
      }
      payload.email = email;
    }

    return await super.update(this.tableName, userId, payload);
  }

  static async acceptTerms(userId) {
    return await super.update(this.tableName, userId, {
      terms_accepted: true,
      terms_accepted_at: new Date(),
    });
  }

  // H8 FIX: account deletion — anonymizes PII rather than a hard DELETE.
  // A hard delete would cascade (ON DELETE CASCADE) through orders,
  // payment_methods, messages, etc., destroying financial/transactional
  // records that may be needed for accounting, disputes, or tax purposes —
  // "delete my account" should remove personal data, not the business's
  // own transaction history. Scrubs name/email/phone/address/social-login
  // ids/push token, sets an unusable random password hash, and revokes
  // every refresh token so no existing session can keep acting as this
  // user (their short-lived access token still expires within 15 minutes
  // regardless).
  static async deleteAccount(userId) {
    const anonymizedEmail = `deleted-${userId}@flash.invalid`;
    const password_hash = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 12);

    const result = await this.query(
      `UPDATE users
       SET name = 'Deleted User', email = $2, password_hash = $3,
           phone = NULL, address = NULL, apple_id = NULL, google_id = NULL,
           push_token = NULL, updated_at = NOW()
       WHERE id = $1
       RETURNING id`,
      [userId, anonymizedEmail, password_hash],
    );

    if (!result.rows.length) {
      throw new Error("User not found");
    }

    await this.query(
      `UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
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
