const express = require("express");
const router = express.Router();
const { authenticate, requireRole } = require("../middleware/auth");
const SizingController = require("../controllers/sizingController");

router.get("/guide", SizingController.getMeasurementGuide);
router.get(
  "/profile",
  authenticate,
  requireRole("user"),
  SizingController.getSizeProfile,
);
router.post(
  "/profile",
  authenticate,
  requireRole("user"),
  SizingController.saveSizeProfile,
);
router.get(
  "/recommend/:storeId/:category",
  authenticate,
  requireRole("user"),
  SizingController.getRecommendation,
);
// Writes to the shared, global brand_size_mappings table that every
// customer's size recommendations depend on — was reachable by any
// authenticated user or driver with no elevated privilege at all.
router.post("/mappings/seed", authenticate, requireRole("admin"), SizingController.seedMappings);

module.exports = router;
