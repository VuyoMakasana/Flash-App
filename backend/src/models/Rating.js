'use strict';

const BaseModel = require('./BaseModel');

/**
 * Rating.js
 *
 * Item 4 (Phase 4 audit): drivers.rating previously had no submission flow
 * at all — a static DEFAULT 5.00 column nothing ever wrote to. One rating
 * per completed order (UNIQUE(order_id) on driver_ratings); the driver's
 * aggregate rating is recomputed from all their rating rows on every new
 * submission, not manually set.
 */
class Rating extends BaseModel {
  static async submitRating(orderId, userId, driverId, rating, comment) {
    const ratingNum = parseInt(rating, 10);
    if (!Number.isInteger(ratingNum) || ratingNum < 1 || ratingNum > 5) {
      throw new Error('Rating must be an integer between 1 and 5');
    }

    return await this.transaction(async (client) => {
      const orderResult = await client.query(
        `SELECT id, user_id, driver_id, status FROM orders WHERE id = $1 FOR UPDATE`,
        [orderId],
      );
      if (!orderResult.rows.length) throw new Error('Order not found');

      const order = orderResult.rows[0];
      if (String(order.user_id) !== String(userId)) {
        throw new Error('Not your order');
      }
      if (!order.driver_id || String(order.driver_id) !== String(driverId)) {
        throw new Error('This driver was not assigned to this order');
      }
      if (order.status !== 'completed') {
        throw new Error('You can only rate a delivery after it is completed');
      }

      const existing = await client.query(
        `SELECT id FROM driver_ratings WHERE order_id = $1`,
        [orderId],
      );
      if (existing.rows.length) {
        throw new Error('You have already rated this delivery');
      }

      await client.query(
        `INSERT INTO driver_ratings (order_id, user_id, driver_id, rating, comment)
         VALUES ($1, $2, $3, $4, $5)`,
        [orderId, userId, driverId, ratingNum, comment ? String(comment).slice(0, 1000) : null],
      );

      const agg = await client.query(
        `SELECT ROUND(AVG(rating)::numeric, 2) AS avg_rating, COUNT(*) AS rating_count
         FROM driver_ratings WHERE driver_id = $1`,
        [driverId],
      );
      const avgRating = parseFloat(agg.rows[0]?.avg_rating || ratingNum);

      await client.query(
        `UPDATE drivers SET rating = $1, updated_at = NOW() WHERE id = $2`,
        [avgRating, driverId],
      );

      return {
        rating: ratingNum,
        driverAvgRating: avgRating,
        driverRatingCount: parseInt(agg.rows[0]?.rating_count || 1, 10),
      };
    });
  }

  static async getForOrder(orderId) {
    const result = await this.query(
      `SELECT id, order_id, driver_id, rating, comment, created_at
       FROM driver_ratings WHERE order_id = $1`,
      [orderId],
    );
    return result.rows[0] || null;
  }
}

module.exports = Rating;
