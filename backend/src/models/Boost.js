const BaseModel = require("./BaseModel");

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

  static async purchaseBoost(storeId, storeName, boostType) {
    const plan = BOOST_PLANS[boostType];
    if (!plan) {
      throw new Error("Invalid boost type");
    }

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + plan.days);

    const result = await this.query(
      `INSERT INTO store_boosts (store_id, store_name, boost_type, price_paid, starts_at, expires_at, status)
       VALUES ($1,$2,$3,$4,NOW(),$5,'active') RETURNING *`,
      [storeId, storeName, boostType, plan.price, expiresAt],
    );

    return {
      boost: result.rows[0],
      message: `${plan.label} activated for ${plan.days} days`,
    };
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
