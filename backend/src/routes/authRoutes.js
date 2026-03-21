const express = require("express");
const router = express.Router();
const { body } = require("express-validator");
const AuthController = require("../controllers/authController");

router.post(
  "/user/register",
  [
    body("name").trim().notEmpty().withMessage("Name is required"),
    body("email")
      .isEmail()
      .normalizeEmail()
      .withMessage("Valid email required"),
    body("password")
      .isLength({ min: 6 })
      .withMessage("Password must be at least 6 characters"),
  ],
  AuthController.registerUser,
);

router.post(
  "/user/login",
  [body("email").isEmail().normalizeEmail(), body("password").notEmpty()],
  AuthController.loginUser,
);

router.post("/user/accept-terms", AuthController.acceptTerms);

router.post(
  "/driver/register",
  [
    body("name").trim().notEmpty(),
    body("email").isEmail().normalizeEmail(),
    body("password").isLength({ min: 6 }),
    body("phone").notEmpty().withMessage("Phone number required"),
  ],
  AuthController.registerDriver,
);

router.post(
  "/driver/login",
  [body("email").isEmail().normalizeEmail(), body("password").notEmpty()],
  AuthController.loginDriver,
);

module.exports = router;
