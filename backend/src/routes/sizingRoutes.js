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
router.post("/mappings/seed", authenticate, SizingController.seedMappings);

module.exports = router;
