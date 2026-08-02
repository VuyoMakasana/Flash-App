const BaseModel = require("./BaseModel");

// Public-facing reads (getProducts/getProduct) must never return cost_price —
// it's Flash's internal wholesale/margin data, not something either public
// endpoint should expose to an unauthenticated caller. Admin-only writes
// (addProduct/updateStock) still return it via RETURNING * since that's an
// admin action that legitimately needs to see what it just set.
// Table-qualified so getProducts (below) can safely add a JOIN to stores —
// both tables have their own id/is_active/created_at columns, and an
// unqualified list would become ambiguous the moment a second table is in
// scope. getProduct further down has no join, so qualification is a no-op
// there — same result set either way.
const PUBLIC_COLUMNS = `flash_inventory.id, flash_inventory.product_name, flash_inventory.category,
  flash_inventory.brand, flash_inventory.price, flash_inventory.sizes, flash_inventory.stock_by_size,
  flash_inventory.image_url, flash_inventory.description, flash_inventory.is_active,
  flash_inventory.created_at, flash_inventory.updated_at`;

class Inventory extends BaseModel {
  static async getProducts(category, page = 1, limit = 20) {
    const offset = (page - 1) * limit;
    // Final admin-panel completion pass, §4 — a real, active boost
    // (Boost.activateBoost, product_id-targeted) now actually ranks its
    // product first, instead of store_boosts existing with no observable
    // effect on any listing. Correlated EXISTS against flash_inventory's
    // own id, so no join/column-list change is needed above.
    const boostedFirst = `EXISTS (
      SELECT 1 FROM store_boosts sb
      WHERE sb.product_id = flash_inventory.id AND sb.status = 'active' AND sb.expires_at > NOW()
    ) DESC`;
    // Multi-tenant Stage 6, decision 4 — thread store_id + a joined store
    // name into the one public listing query flash-user-app actually reads.
    // flash_inventory.store_id has been NOT NULL with a real FK to stores
    // since migration v34, so this is a plain JOIN (not LEFT JOIN) — every
    // row is guaranteed to have a matching store. Customer-facing UX beyond
    // exposing these two fields is explicitly out of scope for this pass.
    const columns = `${PUBLIC_COLUMNS}, flash_inventory.store_id, stores.name AS store_name`;
    const query = category
      ? `SELECT ${columns} FROM flash_inventory JOIN stores ON stores.id = flash_inventory.store_id WHERE flash_inventory.is_active=true AND flash_inventory.category=$3 ORDER BY ${boostedFirst}, flash_inventory.created_at DESC LIMIT $1 OFFSET $2`
      : `SELECT ${columns} FROM flash_inventory JOIN stores ON stores.id = flash_inventory.store_id WHERE flash_inventory.is_active=true ORDER BY ${boostedFirst}, flash_inventory.created_at DESC LIMIT $1 OFFSET $2`;
    const params = category ? [limit, offset, category] : [limit, offset];
    const result = await this.query(query, params);
    return result.rows;
  }

  static async getProduct(productId) {
    const result = await this.query(
      `SELECT ${PUBLIC_COLUMNS} FROM flash_inventory WHERE id=$1 AND is_active=true`,
      [productId],
    );
    return result.rows[0];
  }

  static async addProduct(productData) {
    const {
      product_name,
      category,
      brand,
      price,
      cost_price,
      sizes,
      stock_by_size,
      image_url,
      description,
    } = productData;
    const result = await this.query(
      `INSERT INTO flash_inventory (product_name, category, brand, price, cost_price, sizes, stock_by_size, image_url, description)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        product_name,
        category,
        brand,
        price,
        cost_price,
        JSON.stringify(sizes || []),
        JSON.stringify(stock_by_size || {}),
        image_url,
        description,
      ],
    );
    return result.rows[0];
  }

  static async updateStock(productId, stockBySize) {
    const result = await this.query(
      `UPDATE flash_inventory SET stock_by_size=$1, updated_at=NOW() WHERE id=$2 RETURNING *`,
      [JSON.stringify(stockBySize), productId],
    );
    return result.rows[0];
  }

  static async deleteProduct(productId) {
    await this.query(
      "UPDATE flash_inventory SET is_active=false, updated_at=NOW() WHERE id=$1",
      [productId],
    );
  }
}

module.exports = Inventory;
