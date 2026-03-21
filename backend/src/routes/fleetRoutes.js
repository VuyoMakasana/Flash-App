const express = require("express");
const router = express.Router();
const { authenticate, requireRole } = require("../middleware/auth");
const FleetController = require("../controllers/fleetController");

router.get(
  "/clusters",
  authenticate,
  requireRole("driver"),
  FleetController.getClusters,
);
router.post(
  "/run",
  authenticate,
  requireRole("admin"),
  FleetController.runIntelligence,
);

module.exports = router;
