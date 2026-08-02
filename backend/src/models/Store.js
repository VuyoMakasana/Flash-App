const BaseModel = require("./BaseModel");

// Public-facing reads (listActive/findPublicById) must never return
// owner_name/owner_email/owner_phone — that's staff-only contact info, per
// DOMAIN_OWNERSHIP_AUTHORITY_SPECIFICATION.md §1 ("Can read: its own
// Owner/staff; Flash Administrators; not other stores, ever"). Same
// allowlist discipline Inventory.js's PUBLIC_COLUMNS already established
// for products.
const PUBLIC_COLUMNS = `id, name, logo_url, banner_url, description, address`;

// Multi-tenant foundation (docs/audits/MULTI_TENANT_ARCHITECTURE_BLUEPRINT.md).
class Store extends BaseModel {
  static async findById(id) {
    const result = await this.query("SELECT * FROM stores WHERE id=$1", [id]);
    return result.rows[0] || null;
  }

  // Multi-tenant Stage 7 — the customer-facing storefront's real store
  // directory. Public, unauthenticated (customers have no store_id claim,
  // per MULTI_TENANT_ARCHITECTURE_BLUEPRINT.md §1.5), so only the safe
  // column set above is ever selected.
  static async listActive(page = 1, limit = 20) {
    const offset = (page - 1) * limit;
    const result = await this.query(
      `SELECT ${PUBLIC_COLUMNS} FROM stores WHERE is_active = true ORDER BY created_at LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return result.rows;
  }

  // Single-store-detail counterpart to listActive — same public column
  // allowlist, used by the storefront's individual store page.
  static async findPublicById(id) {
    const result = await this.query(
      `SELECT ${PUBLIC_COLUMNS} FROM stores WHERE id=$1 AND is_active = true`,
      [id],
    );
    return result.rows[0] || null;
  }

  // Single-store-only lookup, used everywhere a real store_id is needed but
  // there is no multi-store selection step yet (order creation, Boost's
  // activateBoost). Once a real second store exists, every call site of
  // this method becomes the place that needs a real selection step —
  // deliberately named "default", not "only", so that migration is a
  // search for this one method, not a hunt through call sites.
  static async getDefaultStoreId() {
    const result = await this.query(`SELECT id FROM stores WHERE is_active = true LIMIT 1`);
    return result.rows[0]?.id || null;
  }
}

module.exports = Store;
