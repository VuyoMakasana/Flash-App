const express = require("express");
const router = express.Router();
const { authenticate } = require("../middleware/auth");
const MessageController = require("../controllers/messageController");

router.get("/:orderId", authenticate, MessageController.getMessages);
router.post("/:orderId", authenticate, MessageController.sendMessage);
router.get("/:orderId/unread", authenticate, MessageController.getUnreadCount);

module.exports = router;
