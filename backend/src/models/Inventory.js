const BaseModel = require("./BaseModel");

class Inventory extends BaseModel {
  static async getProducts(category, page = 1, limit = 20) {
    const offset = (page - 1) * limit;
    const query = category
      ? `SELECT * FROM flash_inventory WHERE is_active=true AND category=$3 ORDER BY created_at DESC LIMIT $1 OFFSET $2`
      : `SELECT * FROM flash_inventory WHERE is_active=true ORDER BY created_at DESC LIMIT $1 OFFSET $2`;
    const params = category ? [limit, offset, category] : [limit, offset];
    const result = await this.query(query, params);
    return result.rows;
  }

  static async getProduct(productId) {
    const result = await this.query(
      "SELECT * FROM flash_inventory WHERE id=$1 AND is_active=true",
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
