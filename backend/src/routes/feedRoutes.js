const express = require("express");
const router = express.Router();
const { authenticate, requireRole } = require("../middleware/auth");
const { validateId } = require("../middleware/validation");
const FeedController = require("../controllers/feedController");

router.get("/", authenticate, FeedController.getFeed);
router.post("/", authenticate, requireRole("user"), FeedController.createPost);
router.post(
  "/:postId/like",
  authenticate,
  requireRole("user"),
  validateId,
  FeedController.likePost,
);
router.get("/:postId/comments", authenticate, validateId, FeedController.getComments);
router.post(
  "/:postId/comments",
  authenticate,
  requireRole("user"),
  validateId,
  FeedController.addComment,
);
router.delete(
  "/:postId",
  authenticate,
  requireRole("user"),
  validateId,
  FeedController.deletePost,
);

module.exports = router;
