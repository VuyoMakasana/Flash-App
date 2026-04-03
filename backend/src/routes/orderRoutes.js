const express = require("express");
const router = express.Router();
const { authenticate, requireRole } = require("../middleware/auth");
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
router.get("/:orderId", authenticate, OrderController.getOrder);
router.put(
  "/:orderId/status",
  authenticate,
  requireRole("driver"),
  OrderController.updateOrderStatus,
);
router.post(
  "/:orderId/return",
  authenticate,
  requireRole("user"),
  OrderController.requestReturn,
);
router.post(
  "/:orderId/select-driver",
  authenticate,
  requireRole("user"),
  OrderController.selectDriver,
);
router.post(
  "/:orderId/cancel",
  authenticate,
  requireRole("user"),
  OrderController.cancelOrder,
);

module.exports = router;
