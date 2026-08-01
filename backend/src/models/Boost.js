const BaseModel = require("./BaseModel");
const paystackService = require("../services/paystackService");

const BOOST_PLANS = {
  search_top: {
    price: 500,
    days: 7,
    label: "Top of Search",
    description: "Appear first in all search results for 7 days",
  },
  homepage: {
    price: 1500,
    days: 7,
    label: "Homepage Feature",
    description: "Featured store slot on homepage for 7 days",
  },
  flash_sale: {
    price: 800,
    days: 3,
    label: "Flash Sale Badge",
    description: "Run a flash sale with push notification blast",
  },
  monthly: {
    price: 3500,
    days: 30,
    label: "Monthly Premium",
    description: "All boost features for a full month",
  },
};

class Boost extends BaseModel {
  static async getActiveBoosts() {
    const result = await this.query(
      `SELECT * FROM store_boosts WHERE status='active' AND expires_at>NOW() ORDER BY created_at DESC`,
    );
    return result.rows;
  }

  static async getPromotions() {
    const result = await this.query(
      `SELECT * FROM store_promotions WHERE is_active=true AND expires_at>NOW() ORDER BY created_at DESC`,
    );
    return result.rows;
  }

  // Final admin-panel completion pass, §4 — real Paystack charge, same
  // pattern as Subscription.purchaseDriverPlan/purchasePremium: no
  // store_boosts row is written here at all. This only validates the
  // target product and boost plan, then hands back a Paystack hosted-
  // checkout URL. The row is created by activateBoost() below, called from
  // webhookController once Paystack actually confirms the charge succeeded
  // — so a boost can never appear "active" without a real, verified payment.
  //
  // Requires a real productId (not just a storeId) because this codebase is
  // single-vendor (no `stores` table) — boosting "the store" has nothing to
  // rank above, so it can never produce an observable effect. Boosting a
  // specific product against the rest of the catalogue is the only version
  // of this feature that does something real (see Inventory.getProducts).
  static async purchaseBoost(productId, boostType, adminId) {
    const plan = BOOST_PLANS[boostType];
    if (!plan) {
      throw new Error("Invalid boost type");
    }

    const productResult = await this.query(
      `SELECT id, product_name FROM flash_inventory WHERE id=$1 AND is_active=true`,
      [productId],
    );
    if (!productResult.rows.length) {
      throw new Error("Product not found or inactive");
    }
    const product = productResult.rows[0];

    const adminResult = await this.query(`SELECT email FROM admins WHERE id=$1`, [adminId]);
    if (!adminResult.rows.length) {
      throw new Error("Admin not found");
    }

    const amountInCents = Math.round(plan.price * 100);
    const paystackRes = await paystackService.initializeGenericCharge(
      adminResult.rows[0].email,
      amountInCents,
      { productId, boostType, type: "store_boost", platform: "flash" },
    );

    return {
      requiresPayment: true,
      authorizationUrl: paystackRes.authorizationUrl,
      message: `Complete payment to activate "${plan.label}" on ${product.product_name}`,
    };
  }

  // Called by webhookController once Paystack confirms a store_boost charge
  // succeeded — the other half of purchaseBoost() above.
  static async activateBoost(productId, boostType, paystackReference) {
    const plan = BOOST_PLANS[boostType];
    if (!plan) throw new Error(`Unknown boost type: ${boostType}`);

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + plan.days);

    // Multi-tenant Stage 1 (migrate.js v30) converted store_boosts.store_id
    // from a free-text tag to a real UUID FK against the new stores table —
    // FLASH_STORE_ID's old "flash_closet" string is no longer a valid value
    // for this column, so the real seeded store row is looked up here instead.
    const storeResult = await this.query(`SELECT id FROM stores WHERE is_active = true LIMIT 1`);
    if (!storeResult.rows.length) throw new Error("No active store found");
    const storeId = storeResult.rows[0].id;

    const result = await this.query(
      `INSERT INTO store_boosts (store_id, store_name, boost_type, price_paid, starts_at, expires_at, status, product_id, paystack_reference)
       VALUES ($1,$2,$3,$4,NOW(),$5,'active',$6,$7) RETURNING *`,
      [storeId, "Flash", boostType, plan.price, expiresAt, productId, paystackReference],
    );

    return result.rows[0];
  }

  static async createPromotion(
    storeId,
    title,
    description,
    discountPercent,
    durationDays = 7,
  ) {
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + durationDays);

    const result = await this.query(
      `INSERT INTO store_promotions (store_id, title, description, discount_percent, starts_at, expires_at)
       VALUES ($1,$2,$3,$4,NOW(),$5) RETURNING *`,
      [storeId, title, description, discountPercent || null, expiresAt],
    );
    return result.rows[0];
  }

  static getPlans() {
    return Object.entries(BOOST_PLANS).map(([id, p]) => ({ id, ...p }));
  }
}

module.exports = Boost;
