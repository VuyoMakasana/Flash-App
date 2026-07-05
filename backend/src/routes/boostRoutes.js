const express = require("express");
const router = express.Router();
const { authenticate, requireRole } = require("../middleware/auth");
const BoostController = require("../controllers/boostController");

// Reads are public — boosted stores/promotions are shown to customers.
router.get("/active", BoostController.getActiveBoosts);
router.get("/promotions", BoostController.getPromotions);
router.get("/plans", BoostController.getPlans);

// Writes are admin-only. There is no self-serve store-owner account system
// in this codebase yet (no `stores` table, no merchant role) — boosts and
// promotions are platform-level merchandising decisions made by Flash ops,
// not a self-serve purchase a customer or driver account should ever be
// able to trigger. Previously these had no role check at all, so any
// authenticated user or driver could grant a store a free, unpaid boost.
router.post("/purchase", authenticate, requireRole("admin"), BoostController.purchaseBoost);
router.post("/promotions", authenticate, requireRole("admin"), BoostController.createPromotion);

module.exports = router;
