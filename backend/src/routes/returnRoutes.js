const express = require("express");
const router = express.Router();
const { authenticate, requireRole } = require("../middleware/auth");
const { validateId } = require("../middleware/validation");
const ReturnController = require("../controllers/returnController");

router.post(
  "/:orderId",
  authenticate,
  requireRole("user"),
  validateId,
  ReturnController.requestReturn,
);
// pickupReturn (the old store-credit, driver-claims-instantly model) has
// been removed — the returns rebuild replaces it with a real reverse-
// delivery order (created by approveReturn below) that a driver accepts
// through the ordinary available-orders flow, same as any other job.
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
// There is no admin dashboard/app anywhere in this codebase — this is
// currently the only way to discover a return exists and needs action.
router.get(
  "/admin/pending",
  authenticate,
  requireRole("admin"),
  ReturnController.getPendingReturns,
);
router.post(
  "/:returnId/approve",
  authenticate,
  requireRole("admin"),
  validateId,
  ReturnController.approveReturn,
);
router.post(
  "/:returnId/reject",
  authenticate,
  requireRole("admin"),
  validateId,
  ReturnController.rejectReturn,
);
router.post(
  "/:returnId/finalize-refund",
  authenticate,
  requireRole("admin"),
  validateId,
  ReturnController.finalizeRefund,
);

module.exports = router;
