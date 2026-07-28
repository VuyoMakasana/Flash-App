const express = require("express");
const router = express.Router();
const { authenticate, requireRole } = require("../middleware/auth");
const { validateId } = require("../middleware/validation");
const { orderLimiter } = require("../middleware/rateLimiter");
const OrderController = require("../controllers/orderController");

// orderLimiter (5/min) is scoped to this exact route, not the whole
// /api/orders/* prefix -- it was previously mounted in server.js as
// app.use("/api/orders/", orderLimiter), which as an Express path-prefix
// mount applied to every method under /api/orders/*, not just creation.
// That meant a driver's normal handful of status updates through one
// delivery, or a customer checking their order a couple of times, shared
// the same 5-per-minute-per-IP budget as order creation and could get
// blocked with a misleading "Too many orders created" error on requests
// that never created anything.
router.post(
  "/",
  orderLimiter,
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
