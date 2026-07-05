const express = require("express");
const router = express.Router();
const { authenticate, requireRole, requireApprovedDriver } = require("../middleware/auth");
const { validateId } = require("../middleware/validation");
const ReturnController = require("../controllers/returnController");

router.post(
  "/:orderId",
  authenticate,
  requireRole("user"),
  validateId,
  ReturnController.requestReturn,
);
// requireApprovedDriver was missing here — every other driver-claims-a-job
// endpoint (accept order, cancel assigned order, view available orders)
// chains it after requireRole('driver'). Without it, a newly self-registered,
// unvetted driver account (a JWT is issued immediately at registration,
// before any document review) could claim any pending return pickup and
// trigger immediate store-credit issuance to the customer.
router.post(
  "/:returnId/pickup",
  authenticate,
  requireRole("driver"),
  requireApprovedDriver,
  validateId,
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
  validateId,
  ReturnController.approveReturn,
);

module.exports = router;
