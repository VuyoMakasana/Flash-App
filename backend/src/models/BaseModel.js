const pool = require("../config/database");

class BaseModel {
  static async query(sql, params = []) {
    try {
      const result = await pool.query(sql, params);
      return result;
    } catch (error) {
      console.error(`Database error in ${this.name}:`, error);
      throw error;
    }
  }

  static async findById(id, table) {
    const result = await this.query(`SELECT * FROM ${table} WHERE id = $1`, [
      id,
    ]);
    return result.rows[0];
  }

  static async findAll(table, conditions = {}, options = {}) {
    let sql = `SELECT * FROM ${table}`;
    const values = [];
    const whereClauses = [];

    Object.entries(conditions).forEach(([key, value], index) => {
      whereClauses.push(`${key} = $${index + 1}`);
      values.push(value);
    });

    if (whereClauses.length > 0) {
      sql += ` WHERE ${whereClauses.join(" AND ")}`;
    }

    if (options.orderBy) {
      sql += ` ORDER BY ${options.orderBy}`;
    }

    if (options.limit) {
      sql += ` LIMIT $${values.length + 1}`;
      values.push(options.limit);
    }
    if (options.offset) {
      sql += ` OFFSET $${values.length + 1}`;
      values.push(options.offset);
    }

    const result = await this.query(sql, values);
    return result.rows;
  }

  static async create(table, data) {
    const keys = Object.keys(data);
    const values = Object.values(data);
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(", ");
    const sql = `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${placeholders}) RETURNING *`;
    const result = await this.query(sql, values);
    return result.rows[0];
  }

  static async update(table, id, data) {
    const keys = Object.keys(data);
    const values = Object.values(data);
    const setClause = keys.map((key, i) => `${key} = $${i + 1}`).join(", ");
    const sql = `UPDATE ${table} SET ${setClause}, updated_at = NOW() WHERE id = $${keys.length + 1} RETURNING *`;
    const result = await this.query(sql, [...values, id]);
    return result.rows[0];
  }

  static async delete(table, id) {
    const result = await this.query(
      `DELETE FROM ${table} WHERE id = $1 RETURNING id`,
      [id],
    );
    return result.rows[0];
  }

  static async transaction(callback) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await callback(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = BaseModel;
