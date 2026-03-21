const express = require("express");
const router = express.Router();
const { authenticate } = require("../middleware/auth");
const TrackingController = require("../controllers/trackingController");

router.get(
  "/order/:orderId",
  authenticate,
  TrackingController.getOrderLocation,
);

module.exports = router;
