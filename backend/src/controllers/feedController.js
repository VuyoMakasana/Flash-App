const Feed = require("../models/Feed");

class FeedController {
  static async getFeed(req, res) {
    const { page = 1, limit = 20 } = req.query;
    try {
      const result = await Feed.getFeed(req.userId, page, limit);
      res.json(result);
    } catch (err) {
      console.error("[Feed] getFeed error:", err.message);
      res.status(500).json({ error: "Failed to fetch feed" });
    }
  }

  static async createPost(req, res) {
    const { image_url, caption, tagged_products } = req.body;
    if (!image_url) {
      return res.status(400).json({ error: "Image URL required" });
    }

    try {
      const post = await Feed.createPost(
        req.userId,
        image_url,
        caption,
        tagged_products,
      );
      res.status(201).json({ post });
    } catch (err) {
      console.error("[Feed] createPost error:", err.message);
      res.status(500).json({ error: "Failed to create post" });
    }
  }

  static async likePost(req, res) {
    const { postId } = req.params;
    try {
      const liked = await Feed.toggleLike(postId, req.userId);
      res.json({ liked });
    } catch (err) {
      console.error("[Feed] likePost error:", err.message);
      res.status(500).json({ error: "Failed to like post" });
    }
  }

  static async getComments(req, res) {
    const { postId } = req.params;
    try {
      const comments = await Feed.getComments(postId);
      res.json({ comments });
    } catch (err) {
      console.error("[Feed] getComments error:", err.message);
      res.status(500).json({ error: "Failed to fetch comments" });
    }
  }

  static async addComment(req, res) {
    const { postId } = req.params;
    const { content } = req.body;
    if (!content?.trim()) {
      return res.status(400).json({ error: "Comment cannot be empty" });
    }

    try {
      const comment = await Feed.addComment(postId, req.userId, content.trim());
      res.status(201).json({ comment });
    } catch (err) {
      console.error("[Feed] addComment error:", err.message);
      res.status(500).json({ error: "Failed to add comment" });
    }
  }

  static async deletePost(req, res) {
    const { postId } = req.params;
    try {
      const deleted = await Feed.deletePost(postId, req.userId);
      if (!deleted) {
        return res.status(404).json({ error: "Post not found" });
      }
      res.json({ success: true });
    } catch (err) {
      console.error("[Feed] deletePost error:", err.message);
      res.status(500).json({ error: "Failed to delete post" });
    }
  }
}

module.exports = FeedController;
