const express = require("express");
const router = express.Router();
const { authenticate, requireRole } = require("../middleware/auth");
const UserController = require("../controllers/userController");

router.get("/me", authenticate, requireRole("user"), UserController.getProfile);
router.put(
  "/me",
  authenticate,
  requireRole("user"),
  UserController.updateProfile,
);
router.get(
  "/orders",
  authenticate,
  requireRole("user"),
  UserController.getOrders,
);

router.post(
  "/push-token",
  authenticate,
  requireRole("user"),
  UserController.registerPushToken,
);

module.exports = router;
