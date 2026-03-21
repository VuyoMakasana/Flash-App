const express = require("express");
const router = express.Router();
const multer = require("multer");
const {
  authenticate,
  requireRole,
  requireApprovedDriver,
} = require("../middleware/auth");
const DriverController = require("../controllers/driverController");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ["application/pdf", "image/jpeg", "image/png", "image/jpg"];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only PDF, JPG, and PNG files are allowed"));
    }
  },
});

router.get(
  "/me",
  authenticate,
  requireRole("driver"),
  DriverController.getProfile,
);
router.put(
  "/me",
  authenticate,
  requireRole("driver"),
  DriverController.updateProfile,
);
router.post(
  "/documents/upload",
  authenticate,
  requireRole("driver"),
  upload.single("document"),
  DriverController.uploadDocument,
);
router.post(
  "/online",
  authenticate,
  requireRole("driver"),
  requireApprovedDriver,
  DriverController.setOnlineStatus,
);
router.post(
  "/location",
  authenticate,
  requireRole("driver"),
  DriverController.updateLocation,
);
router.get(
  "/available-orders",
  authenticate,
  requireRole("driver"),
  requireApprovedDriver,
  DriverController.getAvailableOrders,
);
router.post(
  "/orders/:orderId/accept",
  authenticate,
  requireRole("driver"),
  requireApprovedDriver,
  DriverController.acceptOrder,
);
router.get(
  "/earnings",
  authenticate,
  requireRole("driver"),
  DriverController.getEarnings,
);
router.get("/nearby", DriverController.getNearbyDrivers);

module.exports = router;
