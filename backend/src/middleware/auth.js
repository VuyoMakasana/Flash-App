const jwt   = require("jsonwebtoken");
const pool  = require("../config/database");
const { getRequired, getOptional } = require("../config/env");

// ─── AUTHENTICATE ────────────────────────────────────────────────────────────
// Verifies the short-lived access token (15 min).
// If expired the client must use the refresh endpoint to get a new one.
const authenticate = async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer "))
    return res.status(401).json({ error: "No token provided" });

  const token = header.replace("Bearer ", "");

  let decoded;
  // Tracks which secret's signature actually verified this token — never
  // trust the token's own `role` claim alone. Found live during the
  // responsive/security audit pass: a token signed with the plain
  // JWT_SECRET but with `role: 'admin'` written into its payload was
  // ACCEPTED by every admin-gated route, because the two verify attempts
  // below only ever checked "did some secret's signature match," never
  // "does the role this token claims actually match the secret that
  // proved it." Not exploitable by an external attacker without already
  // having JWT_SECRET (nothing in this codebase ever mints a JWT_SECRET
  // token with role:'admin' — confirmed by reading every issueTokenPair()
  // call site), but it silently defeated the ADMIN_JWT_SECRET isolation
  // this project explicitly built (Addendum 2 §0) as a real, defense-in-
  // depth boundary, not just an accident-proofing convenience.
  let verifiedWithAdminSecret = false;
  try {
    const jwtSecret = getRequired("JWT_SECRET", "auth");
    decoded = jwt.verify(token, jwtSecret);
  } catch (err) {
    // ADMIN_JWT_SECRET FIX (docs/audits/ADMIN_PANEL_AUDIT_AND_VISION.md,
    // Addendum 2 §0): admin tokens are now signed with their own secret,
    // separate from the shared user/driver one — a real, cheap isolation
    // improvement. Verifying a correctly-signed admin token against the
    // wrong (user/driver) secret always fails with "invalid signature"
    // (JsonWebTokenError) regardless of expiry, so only retry on that
    // specific error — a genuine TokenExpiredError from the first attempt
    // must still be reported as expired, not masked by a second attempt.
    if (err.name === "JsonWebTokenError") {
      const adminJwtSecret = getOptional("ADMIN_JWT_SECRET", "auth");
      if (adminJwtSecret) {
        try {
          decoded = jwt.verify(token, adminJwtSecret);
          verifiedWithAdminSecret = true;
        } catch (adminErr) {
          if (adminErr.name === "TokenExpiredError")
            return res.status(401).json({ error: "TOKEN_EXPIRED" });
          return res.status(401).json({ error: "Invalid token" });
        }
      } else {
        return res.status(401).json({ error: "Invalid token" });
      }
    } else if (err.name === "TokenExpiredError") {
      return res.status(401).json({ error: "TOKEN_EXPIRED" });
    } else {
      return res.status(401).json({ error: "Authentication failed" });
    }
  }

  // The real fix: a role of 'admin' is only ever legitimate if
  // ADMIN_JWT_SECRET is the secret that actually proved this token — and
  // symmetrically, a token verified against ADMIN_JWT_SECRET has no
  // legitimate reason to claim any role other than 'admin'. Either
  // mismatch means the token's payload was crafted, not issued by this
  // app's real login flow.
  if (decoded.role === "admin" && !verifiedWithAdminSecret) {
    return res.status(401).json({ error: "Invalid token" });
  }
  if (verifiedWithAdminSecret && decoded.role !== "admin") {
    return res.status(401).json({ error: "Invalid token" });
  }

  // CRITICAL FIX: the revocation check below used to share the try/catch
  // above with jwt.verify(), so a DB failure here (e.g. pool exhaustion)
  // fell into the same catch and returned the same 401 a genuinely bad or
  // expired token gets. Confirmed live under load testing: pool timeouts on
  // this exact query surfaced to the client as "Authentication failed" for
  // otherwise perfectly valid, currently-logged-in sessions — client apps
  // generally react to 401 by logging the user out, which is the wrong
  // response to a transient capacity problem. next(err) routes a DB failure
  // to the central errorHandler instead, which defaults to a real 500 —
  // same convention requireApprovedDriver below already uses.
  if (decoded.jti) {
    try {
      const revoked = await pool.query(
        "SELECT 1 FROM revoked_tokens WHERE jti = $1",
        [decoded.jti]
      );
      if (revoked.rows.length)
        return res.status(401).json({ error: "Token revoked" });
    } catch (err) {
      return next(err);
    }
  }

  req.userId   = decoded.id;
  req.userRole = decoded.role;
  if (decoded.status === "approved") req.driverStatus = "approved";
  next();
};

// ─── ROLE GUARD ──────────────────────────────────────────────────────────────
const requireRole = (...roles) => (req, res, next) => {
  if (!req.userRole)          return res.status(401).json({ error: "Not authenticated" });
  if (!roles.includes(req.userRole))
    return res.status(403).json({ error: "Access forbidden. Required role: " + roles.join(" or ") });
  next();
};

// ─── APPROVED DRIVER ─────────────────────────────────────────────────────────
const requireApprovedDriver = async (req, res, next) => {
  if (req.driverStatus === "approved") return next();

  try {
    const result = await pool.query("SELECT status FROM drivers WHERE id = $1", [req.userId]);
    if (!result.rows.length) return res.status(404).json({ error: "Driver not found" });

    const { status } = result.rows[0];
    if (status === "suspended")
      return res.status(403).json({ error: "Account suspended. Contact support.", status });
    if (status !== "approved") {
      const msgs = {
        pending_documents:   "Please upload your required documents.",
        documents_submitted: "Documents under review. You will be notified once approved.",
        under_review:        "Application being reviewed by our team.",
        rejected:            "Application not approved. Contact support.",
      };
      return res.status(403).json({ error: msgs[status] || "Not yet approved", status });
    }
    next();
  } catch (err) { next(err); }
};

// ─── AUTHENTICATE STORE (multi-tenant Stage 2) ──────────────────────────────
// A wholly separate function from authenticate() above, not a third branch
// added to it — verifies only against STORE_JWT_SECRET, with no fallback to
// JWT_SECRET or ADMIN_JWT_SECRET in either direction (docs/audits/
// FLASH_STORE_ADMIN_DESIGN.md §3.2). Because this never shares a verification
// attempt with the other two secrets, there's no "which secret actually
// proved this token" ambiguity to cross-check the way authenticate() must
// for admin tokens (see the comment above it) — a token that verifies here
// was, by construction, minted by this backend's own store-login endpoint.
const authenticateStore = async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer "))
    return res.status(401).json({ error: "No token provided" });

  const token = header.replace("Bearer ", "");

  let decoded;
  try {
    const storeJwtSecret = getRequired("STORE_JWT_SECRET", "store-auth");
    decoded = jwt.verify(token, storeJwtSecret);
  } catch (err) {
    if (err.name === "TokenExpiredError")
      return res.status(401).json({ error: "TOKEN_EXPIRED" });
    return res.status(401).json({ error: "Invalid token" });
  }

  try {
    const [revokedResult, storeUserResult] = await Promise.all([
      decoded.jti
        ? pool.query("SELECT 1 FROM revoked_tokens WHERE jti = $1", [decoded.jti])
        : Promise.resolve({ rows: [] }),
      pool.query("SELECT is_active FROM store_users WHERE id = $1", [decoded.id]),
    ]);
    if (revokedResult.rows.length)
      return res.status(401).json({ error: "Token revoked" });
    // Live is_active check, not just trusting the token's own claims — a
    // deactivated store account (§2 of DOMAIN_OWNERSHIP_AUTHORITY_SPECIFICATION.md,
    // Flash's own incident-response override) must be rejected immediately,
    // not just once its token naturally expires.
    if (!storeUserResult.rows.length || !storeUserResult.rows[0].is_active)
      return res.status(401).json({ error: "Account deactivated" });
  } catch (err) {
    return next(err);
  }

  req.storeUserId = decoded.id;
  req.storeId = decoded.storeId;
  req.storeRole = decoded.role;
  next();
};

// ─── STORE ROLE GUARD ────────────────────────────────────────────────────────
const requireStoreRole = (...roles) => (req, res, next) => {
  if (!req.storeRole) return res.status(401).json({ error: "Not authenticated" });
  if (!roles.includes(req.storeRole))
    return res.status(403).json({ error: "Access forbidden. Required role: " + roles.join(" or ") });
  next();
};

// ─── TENANT ISOLATION GUARD ──────────────────────────────────────────────────
// The single most important piece of new middleware for this whole feature
// (FLASH_STORE_ADMIN_DESIGN.md §3.2/§5.1): rejects any request that names a
// store_id/storeId in its path, query, or body that doesn't match req.storeId
// from the verified token. req.storeId itself is never client-suppliable —
// it was cryptographically bound into the token after this backend verified
// the store user's password, so this check can never be satisfied by a
// forged request even if the client knows another store's real UUID.
const requireOwnStore = (req, res, next) => {
  if (!req.storeId) return res.status(401).json({ error: "Not authenticated" });
  const requestedStoreId =
    req.params?.storeId || req.body?.storeId || req.query?.storeId;
  if (requestedStoreId && String(requestedStoreId) !== String(req.storeId)) {
    return res.status(403).json({ error: "Access forbidden: store mismatch" });
  }
  next();
};

module.exports = {
  authenticate,
  requireRole,
  requireApprovedDriver,
  authenticateStore,
  requireStoreRole,
  requireOwnStore,
};
