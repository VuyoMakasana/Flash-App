const express = require("express");
const router = express.Router();
const { authenticate, requireRole } = require("../middleware/auth");
const { validateId } = require("../middleware/validation");
const UserController = require("../controllers/userController");
const AddressController = require("../controllers/addressController");

router.get("/me", authenticate, requireRole("user"), UserController.getProfile);
router.put(
  "/me",
  authenticate,
  requireRole("user"),
  UserController.updateProfile,
);
router.get(
  "/orders",
  authenticate,
  requireRole("user"),
  UserController.getOrders,
);

router.post(
  "/push-token",
  authenticate,
  requireRole("user"),
  UserController.registerPushToken,
);

// H8 FIX: previously no backend route existed for this at all.
router.delete(
  "/account",
  authenticate,
  requireRole("user"),
  UserController.deleteAccount,
);

// Saved address book — AddressScreen.js was already fully built against
// this exact URL shape, with no backend behind it (every action 404'd).
router.get(
  "/addresses",
  authenticate,
  requireRole("user"),
  AddressController.getAddresses,
);
router.post(
  "/addresses",
  authenticate,
  requireRole("user"),
  AddressController.addAddress,
);
router.patch(
  "/addresses/:addressId",
  authenticate,
  requireRole("user"),
  validateId,
  AddressController.updateAddress,
);
router.delete(
  "/addresses/:addressId",
  authenticate,
  requireRole("user"),
  validateId,
  AddressController.deleteAddress,
);

module.exports = router;
