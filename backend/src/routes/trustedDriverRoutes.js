const express = require("express");
const router = express.Router();
const { authenticate, requireRole } = require("../middleware/auth");
const TrustedDriverController = require("../controllers/trustedDriverController");

router.get(
  "/",
  authenticate,
  requireRole("user"),
  TrustedDriverController.getTrustedDrivers,
);
router.get(
  "/pending",
  authenticate,
  requireRole("user"),
  TrustedDriverController.getPendingRequests,
);
router.post(
  "/:driverId/request",
  authenticate,
  requireRole("user"),
  TrustedDriverController.sendTrustRequest,
);
router.delete(
  "/:driverId",
  authenticate,
  requireRole("user"),
  TrustedDriverController.removeTrustedDriver,
);
router.get(
  "/requests",
  authenticate,
  requireRole("driver"),
  TrustedDriverController.getDriverRequests,
);
router.patch(
  "/:requestId/respond",
  authenticate,
  requireRole("driver"),
  TrustedDriverController.respondToRequest,
);
router.delete(
  "/remove-self/:userId",
  authenticate,
  requireRole("driver"),
  TrustedDriverController.removeSelf,
);
router.get(
  "/:driverId/status",
  authenticate,
  requireRole("user"),
  TrustedDriverController.checkDriverStatus,
);

module.exports = router;
