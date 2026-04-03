const express = require("express");
const router = express.Router();
const { authenticate, requireRole } = require("../middleware/auth");
const ReturnController = require("../controllers/returnController");

router.post(
  "/:orderId",
  authenticate,
  requireRole("user"),
  ReturnController.requestReturn,
);
router.post(
  "/:returnId/pickup",
  authenticate,
  requireRole("driver"),
  ReturnController.pickupReturn,
);
router.get(
  "/credits",
  authenticate,
  requireRole("user"),
  ReturnController.getCredits,
);
router.get(
  "/my",
  authenticate,
  requireRole("user"),
  ReturnController.getUserReturns,
);
router.post(
  "/:returnId/approve",
  authenticate,
  requireRole("admin"),
  ReturnController.approveReturn,
);

module.exports = router;
