const express = require("express");
const router = express.Router();
const { authenticate, requireRole } = require("../middleware/auth");
const { cache } = require("../middleware/cache");
const InventoryController = require("../controllers/inventoryController");

// This is the highest-traffic read in the app — every customer hits it on
// every catalogue page load — and it previously had no caching at all despite
// cache.js already existing (unused anywhere). 60s balances freshness
// (stock/price changes show up quickly) against load; admin mutations below
// also explicitly invalidate it so a change is never masked by a stale hit.
router.get("/", cache(60), InventoryController.getProducts);
router.get("/:productId", cache(60), InventoryController.getProduct);
router.post(
  "/",
  authenticate,
  requireRole("admin"),
  InventoryController.addProduct,
);
router.patch(
  "/:productId/stock",
  authenticate,
  requireRole("admin"),
  InventoryController.updateStock,
);
router.delete(
  "/:productId",
  authenticate,
  requireRole("admin"),
  InventoryController.deleteProduct,
);

module.exports = router;
