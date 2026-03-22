const BaseModel = require("./BaseModel");

class Feed extends BaseModel {
  static async getFeed(userId, page = 1, limit = 20) {
    const offset = (page - 1) * limit;
    const result = await this.query(
      `SELECT fp.*, u.name as user_name,
              json_agg(json_build_object(
                'id', fpp.id, 'product_id', fpp.product_id, 'product_name', fpp.product_name,
                'price', fpp.price, 'tap_x', fpp.tap_x, 'tap_y', fpp.tap_y
              )) FILTER (WHERE fpp.id IS NOT NULL) as tagged_products,
              EXISTS(SELECT 1 FROM feed_likes fl WHERE fl.post_id=fp.id AND fl.user_id=$3) as liked_by_me
       FROM feed_posts fp
       JOIN users u ON u.id=fp.user_id
       LEFT JOIN feed_post_products fpp ON fpp.post_id=fp.id
       WHERE fp.is_active=true
       GROUP BY fp.id, u.name
       ORDER BY fp.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset, userId],
    );

    return {
      posts: result.rows,
      page: parseInt(page),
      hasMore: result.rows.length === parseInt(limit),
    };
  }

  static async createPost(userId, imageUrl, caption, taggedProducts = []) {
    return await this.transaction(async (client) => {
      const post = await client.query(
        `INSERT INTO feed_posts (user_id, image_url, caption) VALUES ($1,$2,$3) RETURNING *`,
        [userId, imageUrl, caption || null],
      );

      const postId = post.rows[0].id;

      if (taggedProducts?.length) {
        for (const p of taggedProducts) {
          await client.query(
            `INSERT INTO feed_post_products (post_id, product_id, product_name, price, store_id, tap_x, tap_y)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [
              postId,
              p.product_id,
              p.product_name,
              p.price,
              p.store_id,
              p.tap_x,
              p.tap_y,
            ],
          );
        }
      }

      return post.rows[0];
    });
  }

  static async toggleLike(postId, userId) {
    const existing = await this.query(
      "SELECT id FROM feed_likes WHERE post_id=$1 AND user_id=$2",
      [postId, userId],
    );

    if (existing.rows.length) {
      await this.query(
        "DELETE FROM feed_likes WHERE post_id=$1 AND user_id=$2",
        [postId, userId],
      );
      await this.query(
        "UPDATE feed_posts SET likes_count=GREATEST(0,likes_count-1) WHERE id=$1",
        [postId],
      );
      return false;
    } else {
      await this.query(
        "INSERT INTO feed_likes (post_id, user_id) VALUES ($1,$2)",
        [postId, userId],
      );
      await this.query(
        "UPDATE feed_posts SET likes_count=likes_count+1 WHERE id=$1",
        [postId],
      );
      return true;
    }
  }

  static async getComments(postId) {
    const result = await this.query(
      `SELECT fc.*, u.name as user_name
       FROM feed_comments fc
       JOIN users u ON u.id=fc.user_id
       WHERE fc.post_id=$1
       ORDER BY fc.created_at ASC
       LIMIT 100`,
      [postId],
    );
    return result.rows;
  }

  static async addComment(postId, userId, content) {
    const result = await this.query(
      `INSERT INTO feed_comments (post_id, user_id, content)
       VALUES ($1,$2,$3) RETURNING *`,
      [postId, userId, content],
    );

    await this.query(
      "UPDATE feed_posts SET comments_count=comments_count+1 WHERE id=$1",
      [postId],
    );

    return result.rows[0];
  }

  static async deletePost(postId, userId) {
    const result = await this.query(
      "UPDATE feed_posts SET is_active=false WHERE id=$1 AND user_id=$2 RETURNING id",
      [postId, userId],
    );
    return result.rows.length > 0;
  }
}

module.exports = Feed;
