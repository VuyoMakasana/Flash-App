const BaseModel = require("./BaseModel");

class Trends extends BaseModel {
  static async getCityTrends() {
    const result = await this.query(`
      SELECT city, category, COUNT(*) as browse_count,
             COUNT(DISTINCT user_id) as unique_users
      FROM browsing_events
      WHERE created_at > NOW() - INTERVAL '7 days' AND city IS NOT NULL
      GROUP BY city, category
      ORDER BY browse_count DESC
      LIMIT 50
    `);
    return result.rows;
  }

  static async getCategoryTrends(days = 7) {
    const result = await this.query(`
      SELECT category,
             COUNT(*) as browse_count,
             COUNT(DISTINCT user_id) as unique_users,
             AVG(duration_seconds) as avg_view_time
      FROM browsing_events
      WHERE created_at > NOW() - INTERVAL '${parseInt(days)} days'
        AND category IS NOT NULL
      GROUP BY category
      ORDER BY browse_count DESC
    `);
    return result.rows;
  }

  static async getPriceTrends() {
    const result = await this.query(`
      SELECT
        CASE
          WHEN oi.unit_price < 300 THEN 'Under R300'
          WHEN oi.unit_price < 600 THEN 'R300-R600'
          WHEN oi.unit_price < 1000 THEN 'R600-R1000'
          WHEN oi.unit_price < 2000 THEN 'R1000-R2000'
          ELSE 'Over R2000'
        END as price_band,
        COUNT(*) as units_sold,
        SUM(oi.total_price) as revenue
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE o.status IN ('completed','delivered')
        AND o.created_at > NOW() - INTERVAL '30 days'
      GROUP BY price_band
      ORDER BY units_sold DESC
    `);
    return result.rows;
  }

  static async getTopProducts(days = 30, limit = 10) {
    const result = await this.query(
      `
      SELECT oi.product_id, oi.product_name,
             COUNT(*) as times_ordered,
             SUM(oi.quantity) as units_sold,
             SUM(oi.total_price) as total_revenue
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE o.status IN ('completed','delivered')
        AND o.created_at > NOW() - INTERVAL '${parseInt(days)} days'
      GROUP BY oi.product_id, oi.product_name
      ORDER BY units_sold DESC
      LIMIT $1
    `,
      [parseInt(limit)],
    );
    return result.rows;
  }

  static async recordBrowsingEvent(userId, data) {
    const { productId, category, lat, lng, city, durationSeconds } = data;
    await this.query(
      `INSERT INTO browsing_events (user_id, product_id, category, lat, lng, city, duration_seconds)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        userId,
        productId || null,
        category || null,
        lat || null,
        lng || null,
        city || null,
        durationSeconds || 0,
      ],
    );
  }
}

module.exports = Trends;
