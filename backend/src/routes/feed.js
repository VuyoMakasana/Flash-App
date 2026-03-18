const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { authenticate, requireRole } = require('../middleware/auth');

// ─── GET FEED ─────────────────────────────────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const offset = (page - 1) * limit;
  try {
    const result = await pool.query(
      `SELECT fp.*, u.name as user_name,
              json_agg(json_build_object('id',fpp.id,'product_id',fpp.product_id,'product_name',fpp.product_name,'price',fpp.price,'tap_x',fpp.tap_x,'tap_y',fpp.tap_y)) FILTER (WHERE fpp.id IS NOT NULL) as tagged_products,
              EXISTS(SELECT 1 FROM feed_likes fl WHERE fl.post_id=fp.id AND fl.user_id=$3) as liked_by_me
       FROM feed_posts fp
       JOIN users u ON u.id=fp.user_id
       LEFT JOIN feed_post_products fpp ON fpp.post_id=fp.id
       WHERE fp.is_active=true
       GROUP BY fp.id, u.name
       ORDER BY fp.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset, req.userId]
    );
    res.json({ posts: result.rows, page: parseInt(page), hasMore: result.rows.length === parseInt(limit) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch feed' });
  }
});

// ─── CREATE POST ──────────────────────────────────────────────────────────────
router.post('/', authenticate, requireRole('user'), async (req, res) => {
  const { image_url, caption, tagged_products } = req.body;
  if (!image_url) return res.status(400).json({ error: 'Image URL required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const post = await client.query(
      `INSERT INTO feed_posts (user_id, image_url, caption) VALUES ($1,$2,$3) RETURNING *`,
      [req.userId, image_url, caption || null]
    );
    const postId = post.rows[0].id;

    if (tagged_products?.length) {
      for (const p of tagged_products) {
        await client.query(
          `INSERT INTO feed_post_products (post_id, product_id, product_name, price, store_id, tap_x, tap_y) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [postId, p.product_id, p.product_name, p.price, p.store_id, p.tap_x, p.tap_y]
        );
      }
    }
    await client.query('COMMIT');
    res.status(201).json({ post: post.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Failed to create post' });
  } finally {
    client.release();
  }
});

// ─── LIKE / UNLIKE POST ───────────────────────────────────────────────────────
router.post('/:postId/like', authenticate, requireRole('user'), async (req, res) => {
  const { postId } = req.params;
  try {
    const existing = await pool.query('SELECT id FROM feed_likes WHERE post_id=$1 AND user_id=$2', [postId, req.userId]);
    if (existing.rows.length) {
      await pool.query('DELETE FROM feed_likes WHERE post_id=$1 AND user_id=$2', [postId, req.userId]);
      await pool.query('UPDATE feed_posts SET likes_count=GREATEST(0,likes_count-1) WHERE id=$1', [postId]);
      res.json({ liked: false });
    } else {
      await pool.query('INSERT INTO feed_likes (post_id, user_id) VALUES ($1,$2)', [postId, req.userId]);
      await pool.query('UPDATE feed_posts SET likes_count=likes_count+1 WHERE id=$1', [postId]);
      res.json({ liked: true });
    }
  } catch (err) {
    res.status(500).json({ error: 'Failed to like post' });
  }
});

// ─── GET COMMENTS ─────────────────────────────────────────────────────────────
router.get('/:postId/comments', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT fc.*, u.name as user_name FROM feed_comments fc JOIN users u ON u.id=fc.user_id WHERE fc.post_id=$1 ORDER BY fc.created_at ASC LIMIT 100`,
      [req.params.postId]
    );
    res.json({ comments: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch comments' });
  }
});

// ─── ADD COMMENT ──────────────────────────────────────────────────────────────
router.post('/:postId/comments', authenticate, requireRole('user'), async (req, res) => {
  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'Comment cannot be empty' });
  try {
    const result = await pool.query(
      `INSERT INTO feed_comments (post_id, user_id, content) VALUES ($1,$2,$3) RETURNING *`,
      [req.params.postId, req.userId, content.trim()]
    );
    await pool.query('UPDATE feed_posts SET comments_count=comments_count+1 WHERE id=$1', [req.params.postId]);
    res.status(201).json({ comment: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add comment' });
  }
});

// ─── DELETE POST (own only) ───────────────────────────────────────────────────
router.delete('/:postId', authenticate, requireRole('user'), async (req, res) => {
  try {
    const result = await pool.query('UPDATE feed_posts SET is_active=false WHERE id=$1 AND user_id=$2 RETURNING id', [req.params.postId, req.userId]);
    if (!result.rows.length) return res.status(404).json({ error: 'Post not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete post' });
  }
});

module.exports = router;
