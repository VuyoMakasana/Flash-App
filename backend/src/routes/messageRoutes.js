const express = require("express");
const router = express.Router();
const { authenticate } = require("../middleware/auth");
const { validateId } = require("../middleware/validation");
const MessageController = require("../controllers/messageController");

router.get("/:orderId", authenticate, validateId, MessageController.getMessages);
router.post("/:orderId", authenticate, validateId, MessageController.sendMessage);
router.get("/:orderId/unread", authenticate, validateId, MessageController.getUnreadCount);

module.exports = router;
