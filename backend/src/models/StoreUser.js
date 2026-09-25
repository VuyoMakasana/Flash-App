const BaseModel = require("./BaseModel");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

// Admin Platform Phase 3 (docs/audits/FLASH_STORE_ADMIN_DESIGN.md §3.2) —
// store-scoped staff accounts. Deliberately its own table, never a join
// against admins/users/drivers, so there is no query shape that could
// accidentally cross the trust boundary between a partner store's staff and
// Flash's own internal team. Adapted from the reasoned prior-art version on
// production-readiness-audit, plus force_password_reset/password_changed_at
// (this task's own explicit "own independent forgot/change-password flow"
// requirement — the prior-art version predates that ask).
class StoreUser extends BaseModel {
  static async findByEmail(email) {
    const result = await this.query("SELECT * FROM store_users WHERE email=$1", [email]);
    return result.rows[0] || null;
  }

  static async findById(id) {
    const result = await this.query("SELECT * FROM store_users WHERE id=$1", [id]);
    return result.rows[0] || null;
  }

  // `client` lets a caller run this inside an existing transaction -- store
  // onboarding creates the store and its owner account together, so a failure
  // on either side must leave neither behind.
  static async create({ storeId, name, email, passwordHash, role, forcePasswordReset = false }, client = null) {
    const runner = client || this;
    const result = await runner.query(
      `INSERT INTO store_users (store_id, name, email, password_hash, role, is_active, force_password_reset)
       VALUES ($1, $2, $3, $4, $5, true, $6)
       RETURNING id, store_id, name, email, role, is_active, force_password_reset, created_at`,
      [storeId, name, email, passwordHash, role, forcePasswordReset],
    );
    return result.rows[0];
  }

  static async listByStore(storeId) {
    const result = await this.query(
      `SELECT id, name, email, role, is_active, created_at
       FROM store_users WHERE store_id = $1 ORDER BY created_at ASC`,
      [storeId],
    );
    return result.rows;
  }

  // Scoped in the query itself, not just checked beforehand — a mismatched
  // storeId simply updates zero rows, same convention as storeOrder/
  // storeInventory's own scoped writes.
  static async deactivate(id, storeId) {
    const result = await this.query(
      `UPDATE store_users SET is_active = false, updated_at = NOW()
       WHERE id = $1 AND store_id = $2
       RETURNING id, store_id, name, email, role, is_active`,
      [id, storeId],
    );
    return result.rows[0] || null;
  }

  // Anonymize, never hard-delete — same real pattern already proven for
  // users/drivers (User.deleteAccount): a guaranteed-unique anonymized
  // email (satisfies the real UNIQUE constraint), a real but permanently
  // unusable password hash (random bytes, never known to anyone), is_active
  // = false. The row itself stays, so store_actions' audit trail
  // (store_user_id) stays intact.
  static async anonymize(id, storeId) {
    const anonymizedEmail = `deleted-${id}@flash.invalid`;
    const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 12);
    const result = await this.query(
      `UPDATE store_users
       SET name = 'Deleted Staff', email = $2, password_hash = $3, is_active = false, updated_at = NOW()
       WHERE id = $1 AND store_id = $4
       RETURNING id`,
      [id, anonymizedEmail, passwordHash, storeId],
    );
    return result.rows[0] || null;
  }
}

module.exports = StoreUser;
