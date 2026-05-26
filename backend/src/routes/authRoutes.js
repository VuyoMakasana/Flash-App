const express = require("express");
const router  = express.Router();
const { body } = require("express-validator");
const AuthController = require("../controllers/authController");
const { authLimiter } = require("../middleware/rateLimiter");
const { authenticate } = require("../middleware/auth");

// All auth routes get the strict auth limiter (10 per 15 min)
router.use(authLimiter);

// ── User ─────────────────────────────────────────────────────────────────────
router.post("/user/register",
  [body("name").trim().notEmpty(), body("email").isEmail().normalizeEmail(), body("password").isLength({ min: 6 })],
  AuthController.registerUser
);
router.post("/user/login",
  [body("email").isEmail().normalizeEmail(), body("password").notEmpty()],
  AuthController.loginUser
);
router.post("/user/apple",
  [body("identityToken").notEmpty()],
  AuthController.appleSignInUser
);

router.post(
  "/user/google",
  [body("idToken").notEmpty()],
  AuthController.googleSignInUser
);


router.post(
  '/user/accept-terms',
  authenticate,
  AuthController.acceptTerms
);

// ── Driver ───────────────────────────────────────────────────────────────────
router.post("/driver/register",
  [body("name").trim().notEmpty(), body("email").isEmail().normalizeEmail(), body("password").isLength({ min: 6 }), body("phone").notEmpty()],
  AuthController.registerDriver
);
router.post("/driver/login",
  [body("email").isEmail().normalizeEmail(), body("password").notEmpty()],
  AuthController.loginDriver
);
router.post("/driver/apple",
  [body("identityToken").notEmpty()],
  AuthController.appleSignInDriver
);

router.post(
  "/user/google",
  [body("idToken").notEmpty()],
  AuthController.googleSignInUser
);


// ── Token management ─────────────────────────────────────────────────────────
router.post("/refresh", [body("refreshToken").notEmpty()], AuthController.refreshToken);
router.post("/logout",  AuthController.logout);

module.exports = router;
