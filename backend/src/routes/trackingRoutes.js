const express = require("express");
const router = express.Router();
const { authenticate } = require("../middleware/auth");
const { validateId } = require("../middleware/validation");
const TrackingController = require("../controllers/trackingController");

router.get(
  "/order/:orderId",
  authenticate,
  validateId,
  TrackingController.getOrderLocation,
);

module.exports = router;
