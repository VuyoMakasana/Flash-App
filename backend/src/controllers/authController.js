const User = require("../models/User");
const Driver = require("../models/Driver");
const { generateToken } = require("../utils/helpers");
const { validationResult } = require("express-validator");

class AuthController {
  static async registerUser(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { name, email, password, phone } = req.body;

    try {
      const existing = await User.findByEmail(email);
      if (existing) {
        return res.status(409).json({ error: "Email already registered" });
      }

      const user = await User.create({ name, email, password, phone });
      const token = generateToken(user.id, "user");

      const { password_hash, ...safeUser } = user;
      res.status(201).json({ token, user: safeUser });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Registration failed" });
    }
  }

  static async loginUser(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password } = req.body;

    try {
      const user = await User.verifyPassword(email, password);
      if (!user) {
        return res.status(401).json({ error: "Invalid email or password" });
      }

      const token = generateToken(user.id, "user");
      res.json({ token, user });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Login failed" });
    }
  }

  static async acceptTerms(req, res) {
    const token = req.headers.authorization?.replace("Bearer ", "");
    if (!token) {
      return res.status(401).json({ error: "No token" });
    }

    try {
      const jwt = require("jsonwebtoken");
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      await User.acceptTerms(decoded.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to accept terms" });
    }
  }

  static async registerDriver(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { name, email, password, phone, vehicle_type, vehicle_plate } =
      req.body;

    try {
      const existing = await Driver.findByEmail(email);
      if (existing) {
        return res.status(409).json({ error: "Email already registered" });
      }

      const driver = await Driver.create({
        name,
        email,
        password,
        phone,
        vehicle_type,
        vehicle_plate,
      });
      const token = generateToken(driver.id, "driver");

      const { password_hash, ...safeDriver } = driver;
      res.status(201).json({ token, driver: safeDriver });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Registration failed" });
    }
  }

  static async loginDriver(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password } = req.body;

    try {
      const driver = await Driver.verifyPassword(email, password);
      if (!driver) {
        return res.status(401).json({ error: "Invalid email or password" });
      }

      // Block login if not approved
      if (driver.status !== "approved") {
        const messages = {
          pending_documents:
            "Please upload your required documents to continue.",
          documents_submitted:
            "Your documents are under review. You will be notified once approved.",
          under_review: "Your application is being reviewed by our team.",
          rejected:
            "Your driver application was not approved. Please contact support.",
        };
        return res.status(403).json({
          error: messages[driver.status] || "Account not approved",
          status: driver.status,
        });
      }

      const token = generateToken(driver.id, "driver");
      res.json({ token, driver });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Login failed" });
    }
  }
}

module.exports = AuthController;
