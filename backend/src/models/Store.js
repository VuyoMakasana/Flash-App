const BaseModel = require("./BaseModel");

// Admin Platform Phase 3 (docs/audits/MULTI_TENANT_ARCHITECTURE_BLUEPRINT.md).
// Adapted from the reasoned prior-art version on production-readiness-audit,
// re-verified rather than trusted because it existed.
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

  // Admin Platform Phase 1 (docs/ADMIN_PLATFORM_PHASE1_STORE_IDENTITY_PROPOSAL.md,
  // Option C) — Flash-staff-verified manual onboarding. Creates the store row
  // with its provenance recorded (onboarding_verified_by/_at), never trusted
  // from client input — adminId comes from the authenticated Flash admin
  // session (AdminJS's currentAdmin / the JSON API's req.userId), not the
  // request body.
  static async createVerified({ name, address, lat, lng, ownerName, ownerEmail, ownerPhone, verifiedByAdminId }) {
    const result = await this.query(
      `INSERT INTO stores (name, address, lat, lng, owner_name, owner_email, owner_phone, is_active, onboarding_verified_by, onboarding_verified_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, NOW())
       RETURNING *`,
      [name, address || null, lat ?? null, lng ?? null, ownerName || null, ownerEmail || null, ownerPhone || null, verifiedByAdminId],
    );
    return result.rows[0];
  }

  static async listAll() {
    const result = await this.query(`SELECT * FROM stores ORDER BY created_at ASC`);
    return result.rows;
  }
}

module.exports = Store;
