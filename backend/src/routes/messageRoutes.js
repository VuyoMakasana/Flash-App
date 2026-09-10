const express = require("express");
const router = express.Router();
const { authenticate } = require("../middleware/auth");
const { validateId } = require("../middleware/validation");
const { messageLimiter, reportLimiter } = require("../middleware/rateLimiter");
const MessageController = require("../controllers/messageController");

router.get("/:orderId", authenticate, validateId, MessageController.getMessages);
router.post("/:orderId", authenticate, validateId, messageLimiter, MessageController.sendMessage);
router.get("/:orderId/unread", authenticate, validateId, MessageController.getUnreadCount);
router.post("/:orderId/report", authenticate, validateId, reportLimiter, MessageController.reportUser);
router.post("/:orderId/block", authenticate, validateId, reportLimiter, MessageController.blockUser);

module.exports = router;
