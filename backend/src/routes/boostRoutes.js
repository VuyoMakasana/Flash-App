const express = require("express");
const router = express.Router();
const { authenticate } = require("../middleware/auth");
const BoostController = require("../controllers/boostController");

router.get("/active", BoostController.getActiveBoosts);
router.get("/promotions", BoostController.getPromotions);
router.post("/purchase", authenticate, BoostController.purchaseBoost);
router.post("/promotions", authenticate, BoostController.createPromotion);
router.get("/plans", BoostController.getPlans);

module.exports = router;
