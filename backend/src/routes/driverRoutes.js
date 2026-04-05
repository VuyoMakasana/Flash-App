const express = require("express");
const router = express.Router();
const multer = require("multer");
const {
  authenticate,
  requireRole,
  requireApprovedDriver,
} = require("../middleware/auth");
const { locationLimiter } = require("../middleware/rateLimiter");
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
  locationLimiter,
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
router.post(
  "/orders/:orderId/cancel",
  authenticate,
  requireRole("driver"),
  requireApprovedDriver,
  DriverController.cancelAssignedOrder,
);
router.get(
  "/earnings",
  authenticate,
  requireRole("driver"),
  DriverController.getEarnings,
);
router.get(
  "/wallet",
  authenticate,
  requireRole("driver"),
  DriverController.getWallet,
);
router.post(
  "/wallet/payout-request",
  authenticate,
  requireRole("driver"),
  DriverController.requestPayout,
);
router.get(
  "/active-order",
  authenticate,
  requireRole("driver"),
  DriverController.getActiveOrder,
);
router.get("/nearby", DriverController.getNearbyDrivers);

// ── Bank Account / Payout setup ────────────────────────────────────────────
// Drivers must register a bank account before they can request payouts.
router.get(
  "/bank/supported-banks",
  authenticate,
  requireRole("driver"),
  DriverController.getSupportedBanks,
);
router.post(
  "/bank/verify",
  authenticate,
  requireRole("driver"),
  DriverController.verifyBankAccount,
);
router.post(
  "/bank/save",
  authenticate,
  requireRole("driver"),
  DriverController.saveBankAccount,
);
router.get(
  "/bank/account",
  authenticate,
  requireRole("driver"),
  DriverController.getBankAccount,
);

module.exports = router;

  // ── Push notification token ────────────────────────────────────────────────
  router.post(
    "/push-token",
    authenticate,
    requireRole("driver"),
    DriverController.registerPushToken,
  );
