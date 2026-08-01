const BaseModel = require("./BaseModel");

// Multi-tenant foundation (docs/audits/MULTI_TENANT_ARCHITECTURE_BLUEPRINT.md).
class Store extends BaseModel {
  static async findById(id) {
    const result = await this.query("SELECT * FROM stores WHERE id=$1", [id]);
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
