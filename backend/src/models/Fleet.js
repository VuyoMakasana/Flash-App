const BaseModel = require("./BaseModel");

class Fleet extends BaseModel {
  static async getClusters() {
    const result = await this.query(`
      SELECT category, city,
             ROUND(AVG(lat)::numeric, 4) as center_lat,
             ROUND(AVG(lng)::numeric, 4) as center_lng,
             COUNT(DISTINCT user_id) as user_count
      FROM browsing_events
      WHERE created_at > NOW() - INTERVAL '20 minutes'
        AND lat IS NOT NULL AND category IS NOT NULL
      GROUP BY category, city
      HAVING COUNT(DISTINCT user_id) >= 2
      ORDER BY user_count DESC
      LIMIT 10
    `);
    return result.rows;
  }
}

module.exports = Fleet;
