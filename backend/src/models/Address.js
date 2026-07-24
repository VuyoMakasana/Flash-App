const BaseModel = require("./BaseModel");

class Address extends BaseModel {
  static async getByUser(userId) {
    const result = await this.query(
      `SELECT * FROM addresses WHERE user_id=$1 ORDER BY is_default DESC, created_at DESC`,
      [userId],
    );
    return result.rows;
  }

  static async create(userId, data) {
    return await this.transaction(async (client) => {
      if (data.is_default) {
        await client.query(
          `UPDATE addresses SET is_default=false WHERE user_id=$1`,
          [userId],
        );
      }
      const result = await client.query(
        `INSERT INTO addresses
           (user_id, label, street, apartment, suburb, city, gate_code, landmark, full_address, is_default, lat, lng)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING *`,
        [
          userId,
          data.label || "Home",
          data.street,
          data.apartment || null,
          data.suburb || null,
          data.city || null,
          data.gate_code || null,
          data.landmark || null,
          data.full_address || null,
          !!data.is_default,
          data.lat ?? null,
          data.lng ?? null,
        ],
      );
      return result.rows[0];
    });
  }

  static async update(id, userId, data) {
    return await this.transaction(async (client) => {
      const existing = await client.query(
        `SELECT id FROM addresses WHERE id=$1 AND user_id=$2 FOR UPDATE`,
        [id, userId],
      );
      if (!existing.rows.length) {
        throw new Error("Address not found");
      }

      if (data.is_default) {
        await client.query(
          `UPDATE addresses SET is_default=false WHERE user_id=$1`,
          [userId],
        );
      }

      const fields = ["label", "street", "apartment", "suburb", "city", "gate_code", "landmark", "full_address", "is_default", "lat", "lng"];
      const sets = [];
      const values = [];
      let i = 1;
      for (const f of fields) {
        if (Object.prototype.hasOwnProperty.call(data, f)) {
          sets.push(`${f}=$${i}`);
          values.push(data[f]);
          i += 1;
        }
      }
      if (!sets.length) {
        const unchanged = await client.query(`SELECT * FROM addresses WHERE id=$1`, [id]);
        return unchanged.rows[0];
      }
      sets.push(`updated_at=NOW()`);
      values.push(id, userId);

      const result = await client.query(
        `UPDATE addresses SET ${sets.join(", ")} WHERE id=$${i} AND user_id=$${i + 1} RETURNING *`,
        values,
      );
      return result.rows[0];
    });
  }

  static async delete(id, userId) {
    const result = await this.query(
      `DELETE FROM addresses WHERE id=$1 AND user_id=$2 RETURNING id`,
      [id, userId],
    );
    if (!result.rows.length) {
      throw new Error("Address not found");
    }
  }
}

module.exports = Address;
