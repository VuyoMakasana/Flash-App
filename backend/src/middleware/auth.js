// src/middleware/auth.js
const jwt = require("jsonwebtoken");
const pool = require("../config/database");
const { getRequired } = require("../config/env");

// Verify JWT and attach user to request
const authenticate = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      return res.status(401).json({ error: "No token provided" });
    }

    const token = header.replace("Bearer ", "");
    const jwtSecret = getRequired("JWT_SECRET", "auth");
    if (!jwtSecret) {
      return res.status(500).json({
        error:
          "Authentication system misconfigured. Please contact support. [ERR_JWT_CONFIG]",
      });
    }

    const decoded = jwt.verify(token, jwtSecret);

    // Validate role in token
    req.userId = decoded.id;
    req.userRole = decoded.role; // 'user' | 'driver' | 'admin'

    // Optional: Check if token contains driver status (for backward compatibility)
    if (decoded.status === "approved") {
      req.driverStatus = "approved";
    }

    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Token expired" });
    }
    if (err.name === "JsonWebTokenError") {
      return res.status(401).json({ error: "Invalid token" });
    }
    return res.status(401).json({ error: "Authentication failed" });
  }
};

// Role guard middleware factory
const requireRole =
  (...roles) =>
  (req, res, next) => {
    if (!req.userRole) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    if (!roles.includes(req.userRole)) {
      return res
        .status(403)
        .json({
          error: "Access forbidden. Required role: " + roles.join(" or "),
        });
    }
    next();
  };

// Driver must be approved to access delivery features.
// v3.1 optimization: the driver login already verifies approved status before
// issuing the token. We check the token first, only hit the DB if the token
// was issued before the approved_at field existed (backwards compat).
const requireApprovedDriver = async (req, res, next) => {
  // Fast path: if the JWT contains status='approved', skip the DB query entirely.
  // The token is issued at login and login already blocks non-approved drivers.
  // This eliminates one DB round-trip on every driver endpoint.
  if (req.driverStatus === "approved") return next();

  try {
    const result = await pool.query(
      "SELECT status FROM drivers WHERE id = $1",
      [req.userId],
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: "Driver not found" });
    }
    // ADDED: Check for suspended status — suspended drivers cannot accept orders
    if (result.rows[0].status === 'suspended') {
      return res.status(403).json({
        error: 'Your driver account has been suspended due to repeated order cancellations. Please contact support.',
        status: 'suspended',
      });
    }
    if (result.rows[0].status !== "approved") {
      const messages = {
        pending_documents: "Please upload your required documents to continue.",
        documents_submitted:
          "Your documents are under review. You will be notified once approved.",
        under_review: "Your application is being reviewed by our team.",
        rejected:
          "Your driver application was not approved. Please contact support.",
      };
      return res.status(403).json({
        error:
          messages[result.rows[0].status] ||
          "Driver account is not yet approved",
        status: result.rows[0].status,
      });
    }
    next();
  } catch (err) {
    next(err);
  }
};

module.exports = { authenticate, requireRole, requireApprovedDriver };
