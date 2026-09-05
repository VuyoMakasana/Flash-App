const BaseModel = require("./BaseModel");

// Public-facing reads (getProducts/getProduct) must never return cost_price —
// it's Flash's internal wholesale/margin data, not something either public
// endpoint should expose to an unauthenticated caller. Admin-only writes
// (addProduct/updateStock) still return it via RETURNING * since that's an
// admin action that legitimately needs to see what it just set.
const PUBLIC_COLUMNS = `id, product_name, category, brand, price, sizes,
  stock_by_size, image_url, description, is_active, created_at, updated_at`;

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
    const query = category
      ? `SELECT ${PUBLIC_COLUMNS} FROM flash_inventory WHERE is_active=true AND category=$3 ORDER BY ${boostedFirst}, created_at DESC LIMIT $1 OFFSET $2`
      : `SELECT ${PUBLIC_COLUMNS} FROM flash_inventory WHERE is_active=true ORDER BY ${boostedFirst}, created_at DESC LIMIT $1 OFFSET $2`;
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

  // F-05 remediation — was a bare, non-transactional UPDATE with no lock,
  // unlike Order.create()'s decrement of this same table. Wrapping it in a
  // real transaction with SELECT...FOR UPDATE first makes this write
  // correctly serialize against a concurrent customer checkout on the same
  // product (matching the exact locking primitive already proven correct
  // there) rather than racing it with no ordering guarantee at all.
  //
  // Residual limitation, not fixed by this change: this endpoint accepts a
  // full replacement of stock_by_size, not a per-size delta. Locking
  // guarantees the write is atomic and correctly ordered relative to a
  // concurrent checkout, but if an admin's request was built from a stock
  // count read before that checkout's decrement landed, applying their
  // full (now-stale) object can still overwrite the decrement once this
  // lock is acquired — the values themselves are stale, not the timing.
  // Fully closing that needs either per-size delta semantics or optimistic
  // concurrency (reject the write if the row changed since it was read),
  // both real API/UI changes beyond this fix's scope — flagged, not solved
  // silently, in the audit report this fix responds to.
  static async updateStock(productId, stockBySize) {
    return await this.transaction(async (client) => {
      const existing = await client.query(
        `SELECT id FROM flash_inventory WHERE id = $1 FOR UPDATE`,
        [productId],
      );
      if (!existing.rows.length) return null;

      const result = await client.query(
        `UPDATE flash_inventory SET stock_by_size=$1, updated_at=NOW() WHERE id=$2 RETURNING *`,
        [JSON.stringify(stockBySize), productId],
      );
      return result.rows[0];
    });
  }

  static async deleteProduct(productId) {
    await this.query(
      "UPDATE flash_inventory SET is_active=false, updated_at=NOW() WHERE id=$1",
      [productId],
    );
  }
}

module.exports = Inventory;
