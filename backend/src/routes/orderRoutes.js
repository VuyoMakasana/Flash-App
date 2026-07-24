const express = require("express");
const router = express.Router();
const { authenticate, requireRole } = require("../middleware/auth");
const { validateId } = require("../middleware/validation");
const OrderController = require("../controllers/orderController");

router.post(
  "/",
  authenticate,
  requireRole("user"),
  OrderController.createOrder,
);
router.get(
  "/my-orders",
  authenticate,
  requireRole("user"),
  OrderController.getUserOrders,
);
router.get("/:orderId", authenticate, validateId, OrderController.getOrder);
router.get("/:orderId/photos", authenticate, validateId, OrderController.getOrderPhotos);
router.get("/:orderId/cancellation-preview", authenticate, requireRole("user"), validateId, OrderController.getCancellationPreview);
router.put(
  "/:orderId/status",
  authenticate,
  requireRole("driver"),
  validateId,
  OrderController.updateOrderStatus,
);
router.post(
  "/:orderId/return",
  authenticate,
  requireRole("user"),
  validateId,
  OrderController.requestReturn,
);
router.post(
  "/:orderId/select-driver",
  authenticate,
  requireRole("user"),
  validateId,
  OrderController.selectDriver,
);
router.post(
  "/:orderId/cancel",
  authenticate,
  requireRole("user"),
  validateId,
  OrderController.cancelOrder,
);
router.post(
  "/:orderId/rate-driver",
  authenticate,
  requireRole("user"),
  validateId,
  OrderController.rateDriver,
);

module.exports = router;
