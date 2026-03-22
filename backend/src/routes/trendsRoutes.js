const express = require("express");
const router = express.Router();
const { authenticate, requireRole } = require("../middleware/auth");
const TrendsController = require("../controllers/trendsController");

router.get("/city", authenticate, TrendsController.getCityTrends);
router.get("/category", authenticate, TrendsController.getCategoryTrends);
router.get("/price", authenticate, TrendsController.getPriceTrends);
router.get("/top-products", authenticate, TrendsController.getTopProducts);
router.post(
  "/browse",
  authenticate,
  requireRole("user"),
  TrendsController.recordBrowsingEvent,
);

module.exports = router;
