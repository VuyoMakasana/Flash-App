const BaseModel = require("./BaseModel");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

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

  // Multi-tenant Stage 5 (docs/audits/FLASH_STORE_ADMIN_DESIGN.md §6.2's
  // Settings screen — "Owner role only, managing other store_users for
  // that store"). Unlike Order.js/Inventory.js, this model has never had a
  // platform-wide or public caller to protect — every real caller of
  // StoreUser is already store-portal-only, so store-scoped methods belong
  // here directly rather than as separate controller-only queries.
  static async create({ storeId, name, email, passwordHash, role }) {
    const result = await this.query(
      `INSERT INTO store_users (store_id, name, email, password_hash, role, is_active)
       VALUES ($1, $2, $3, $4, $5, true)
       RETURNING id, store_id, name, email, role, is_active, created_at`,
      [storeId, name, email, passwordHash, role],
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

  // Scoped in the query itself, not just checked beforehand -- a mismatched
  // storeId simply updates zero rows, same convention as storeInventory/
  // storeOrder's own scoped writes.
  static async deactivate(id, storeId) {
    const result = await this.query(
      `UPDATE store_users SET is_active = false, updated_at = NOW()
       WHERE id = $1 AND store_id = $2
       RETURNING id, store_id, name, email, role, is_active`,
      [id, storeId],
    );
    return result.rows[0] || null;
  }

  // Multi-tenant Stage 6 — real self-account deletion for non-Owner roles.
  // Anonymize, never hard-delete, same standing rule and the exact real
  // pattern already proven for users/drivers (User.deleteAccount): a
  // guaranteed-unique anonymized email (satisfies the real UNIQUE
  // constraint), a real but permanently unusable password hash (random
  // bytes, never known to anyone, so the account can never authenticate
  // again), is_active=false. store_users has no phone/address/push-token-
  // shaped PII to null out beyond name/email — a smaller surface than
  // users/drivers, not a shortcut. The row itself stays, so store_actions'
  // audit trail (store_user_id, no cascade concern) stays intact.
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
