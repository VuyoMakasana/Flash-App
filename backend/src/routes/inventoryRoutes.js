const express = require("express");
const router = express.Router();
const { authenticate, requireRole } = require("../middleware/auth");
const InventoryController = require("../controllers/inventoryController");

router.get("/", InventoryController.getProducts);
router.get("/:productId", InventoryController.getProduct);
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
