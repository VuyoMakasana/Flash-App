const BaseModel = require("./BaseModel");

// Admin Platform Phase 3 (docs/audits/MULTI_TENANT_ARCHITECTURE_BLUEPRINT.md).
// Adapted from the reasoned prior-art version on production-readiness-audit,
// re-verified rather than trusted because it existed.
//
// Public-facing reads (listActive/findPublicById) must never return
// owner_name/owner_email/owner_phone — that's staff-only contact info, per
// DOMAIN_OWNERSHIP_AUTHORITY_SPECIFICATION.md §1 ("Can read: its own
// Owner/staff; Flash Administrators; not other stores, ever"). Same
// allowlist discipline Inventory.js's PUBLIC_COLUMNS already established
// for products. Ported from the multi-tenant-stageN line's own Store.js —
// admin-platform's stores table already has every column this needs
// (logo_url/banner_url/description added in migration v40, this same port).
const PUBLIC_COLUMNS = `id, name, logo_url, banner_url, description, address`;

class Store extends BaseModel {
  static async findById(id) {
    const result = await this.query("SELECT * FROM stores WHERE id=$1", [id]);
    return result.rows[0] || null;
  }

  // Single-store-only lookup, used everywhere a real store_id is needed but
  // there is no multi-store checkout-selection step yet (order creation).
  // Deliberately named "default", not "only", so the day a real second
  // store exists, every call site of this method is the place that needs a
  // real selection step — a search for this one method, not a hunt through
  // call sites.
  static async getDefaultStoreId() {
    const result = await this.query(`SELECT id FROM stores WHERE is_active = true LIMIT 1`);
    return result.rows[0]?.id || null;
  }

  // Phase 3 — self-service onboarding. Replaces the previous createVerified(),
  // which was dead code (called from nowhere) AND would have failed against
  // this database anyway: it wrote onboarding_verified_by/onboarding_verified_at,
  // columns that exist only in the test database, never in production.
  //
  // A new application is deliberately created INACTIVE and PENDING. Nothing
  // about it is trusted: it is not visible on the storefront, cannot receive
  // orders, and its owner cannot sign in until a Flash admin approves it. The
  // applicant supplies only contact and business details -- never status,
  // never is_active.
  static async createApplication({ name, address, lat, lng, ownerName, ownerEmail, ownerPhone }, client = null) {
    const runner = client || this;
    const result = await runner.query(
      `INSERT INTO stores (name, address, lat, lng, owner_name, owner_email, owner_phone, is_active, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, false, 'pending')
       RETURNING *`,
      [name, address || null, lat ?? null, lng ?? null, ownerName, ownerEmail, ownerPhone || null],
    );
    return result.rows[0];
  }

  // Approval is the single point where a store becomes real: visible publicly,
  // able to receive orders, and able to be signed into. Scoped to pending/
  // under_review so an already-rejected or suspended store cannot be approved
  // by a duplicate click, and so two admins racing the same application cannot
  // both "win" -- the second UPDATE matches zero rows and returns null.
  static async approve(storeId, adminId, client = null) {
    const runner = client || this;
    const result = await runner.query(
      `UPDATE stores
       SET status = 'approved', is_active = true, reviewed_by = $2, reviewed_at = NOW(),
           rejection_reason = NULL, updated_at = NOW()
       WHERE id = $1 AND status IN ('pending','under_review')
       RETURNING *`,
      [storeId, adminId],
    );
    return result.rows[0] || null;
  }

  static async reject(storeId, adminId, reason, client = null) {
    const runner = client || this;
    const result = await runner.query(
      `UPDATE stores
       SET status = 'rejected', is_active = false, reviewed_by = $2, reviewed_at = NOW(),
           rejection_reason = $3, updated_at = NOW()
       WHERE id = $1 AND status IN ('pending','under_review')
       RETURNING *`,
      [storeId, adminId, reason || null],
    );
    return result.rows[0] || null;
  }

  static async listByStatus(status, limit = 100) {
    const result = await this.query(
      `SELECT id, name, address, owner_name, owner_email, owner_phone, status, created_at
       FROM stores WHERE status = $1 ORDER BY created_at ASC LIMIT $2`,
      [status, limit],
    );
    return result.rows;
  }

  static async listAll() {
    const result = await this.query(`SELECT * FROM stores ORDER BY created_at ASC`);
    return result.rows;
  }

  // Multi-tenant Stage 7 (ported) — the customer-facing storefront's real
  // store directory. Public, unauthenticated (customers have no store_id
  // claim, per MULTI_TENANT_ARCHITECTURE_BLUEPRINT.md §1.5), so only the
  // safe PUBLIC_COLUMNS allowlist above is ever selected — never listAll()'s
  // `SELECT *`, which includes owner contact info.
  static async listActive(page = 1, limit = 20) {
    const offset = (page - 1) * limit;
    const result = await this.query(
      `SELECT ${PUBLIC_COLUMNS} FROM stores WHERE is_active = true AND status = 'approved' ORDER BY created_at LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return result.rows;
  }

  // Single-store-detail counterpart to listActive — same public column
  // allowlist, used by the storefront's individual store page.
  static async findPublicById(id) {
    const result = await this.query(
      `SELECT ${PUBLIC_COLUMNS} FROM stores WHERE id=$1 AND is_active = true AND status = 'approved'`,
      [id],
    );
    return result.rows[0] || null;
  }
}

module.exports = Store;
