const express = require("express");
const router = express.Router();
const { authenticate, requireRole } = require("../middleware/auth");
const AdminController = require("../controllers/adminController");

router.post("/login", AdminController.login);
router.get(
  "/drivers",
  authenticate,
  requireRole("admin"),
  AdminController.getDrivers,
);
router.get(
  "/drivers/:driverId",
  authenticate,
  requireRole("admin"),
  AdminController.getDriverById,
);
router.put(
  "/drivers/:driverId/status",
  authenticate,
  requireRole("admin"),
  AdminController.updateDriverStatus,
);
router.get(
  "/orders",
  authenticate,
  requireRole("admin"),
  AdminController.getOrders,
);
router.get(
  "/stats",
  authenticate,
  requireRole("admin"),
  AdminController.getStats,
);

module.exports = router;
