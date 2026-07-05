const express = require("express");
const router = express.Router();
const { authenticate, requireRole } = require("../middleware/auth");
const FleetController = require("../controllers/fleetController");

// Flash Fleet demand-cluster data is an internal ops/admin analytics view —
// it must never be exposed to drivers or customers.
router.get(
  "/clusters",
  authenticate,
  requireRole("admin"),
  FleetController.getClusters,
);
router.post(
  "/run",
  authenticate,
  requireRole("admin"),
  FleetController.runIntelligence,
);

module.exports = router;
