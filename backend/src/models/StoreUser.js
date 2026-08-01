const BaseModel = require("./BaseModel");

// Multi-tenant Stage 2 (docs/audits/FLASH_STORE_ADMIN_DESIGN.md §3.2) —
// store-scoped staff accounts. Deliberately its own table, never a join
// against admins/users/drivers, so there is no query shape that could
// accidentally cross the trust boundary between a partner store's staff
// and Flash's own internal team.
class StoreUser extends BaseModel {
  static async findByEmail(email) {
    const result = await this.query("SELECT * FROM store_users WHERE email=$1", [email]);
    return result.rows[0] || null;
  }

  static async findById(id) {
    const result = await this.query("SELECT * FROM store_users WHERE id=$1", [id]);
    return result.rows[0] || null;
  }
}

module.exports = StoreUser;
