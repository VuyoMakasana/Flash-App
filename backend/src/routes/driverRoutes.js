const express = require("express");
const router = express.Router();
const multer = require("multer");
const {
  authenticate,
  requireRole,
  requireApprovedDriver,
} = require("../middleware/auth");
const { locationLimiter } = require("../middleware/rateLimiter");
const { validateId } = require("../middleware/validation");
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

// Package-protection pickup/drop-off photos — images only, no PDF.
const uploadPhoto = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/jpg"];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only JPG and PNG photos are allowed"));
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
// Legal/compliance: driverApi.driver.updateProfile({ delete_account: true })
// previously called this route with a body field the backend never read —
// a dead no-op. Apple/Google App Store review requires a real in-app
// self-service deletion path, not just an email process.
router.delete(
  "/account",
  authenticate,
  requireRole("driver"),
  DriverController.deleteAccount,
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
  requireApprovedDriver,
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
  validateId,
  DriverController.acceptOrder,
);
router.post(
  "/orders/:orderId/cancel",
  authenticate,
  requireRole("driver"),
  requireApprovedDriver,
  validateId,
  DriverController.cancelAssignedOrder,
);
// Package protection: a photo is required to advance past these two
// points — the upload and the status transition happen together in one
// call, matching a real one-tap driver flow rather than a separate
// "upload, then advance" pair of steps.
router.post(
  "/orders/:orderId/pickup-photo",
  authenticate,
  requireRole("driver"),
  requireApprovedDriver,
  validateId,
  uploadPhoto.single("photo"),
  DriverController.submitPickupPhoto,
);
router.post(
  "/orders/:orderId/dropoff-photo",
  authenticate,
  requireRole("driver"),
  requireApprovedDriver,
  validateId,
  uploadPhoto.single("photo"),
  DriverController.submitDropoffPhoto,
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
// SECURITY FIX: this had no auth middleware at all — unlike every other
// route in this file — so anyone, unauthenticated, could pull every online
// driver's real name, vehicle plate, and profile photo, plus a live
// distance_km computed against any attacker-supplied lat/lng (real
// haversine, Driver.getNearby). Querying from 3+ points lets an attacker
// triangulate a specific driver's live location with zero login required.
// Only called from CheckoutScreen.js, where the user is already
// authenticated, so this closes the hole with no client-side impact.
router.get(
  "/nearby",
  authenticate,
  requireRole("user"),
  DriverController.getNearbyDrivers,
);

// Real-time checkout-time driver-availability check (audit §2.6) -- a
// boolean-only signal (no names/locations/PII), safe for the checkout
// screen to poll right before payment, unlike /nearby.
router.get(
  "/availability",
  authenticate,
  requireRole("user"),
  DriverController.getAvailability,
);

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

// FIX 6: New route to save driver push token
router.post(
  "/push-token",
  authenticate,
  requireRole("driver"),
  DriverController.savePushToken,
);

module.exports = router;
