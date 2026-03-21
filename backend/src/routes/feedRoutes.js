const express = require("express");
const router = express.Router();
const { authenticate, requireRole } = require("../middleware/auth");
const FeedController = require("../controllers/feedController");

router.get("/", authenticate, FeedController.getFeed);
router.post("/", authenticate, requireRole("user"), FeedController.createPost);
router.post(
  "/:postId/like",
  authenticate,
  requireRole("user"),
  FeedController.likePost,
);
router.get("/:postId/comments", authenticate, FeedController.getComments);
router.post(
  "/:postId/comments",
  authenticate,
  requireRole("user"),
  FeedController.addComment,
);
router.delete(
  "/:postId",
  authenticate,
  requireRole("user"),
  FeedController.deletePost,
);

module.exports = router;
