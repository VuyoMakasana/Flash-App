const cors = require("cors");
const { isProd, isDev } = require("../config/env");

const baseCorsOptions = {
  credentials: true,
  optionsSuccessStatus: 200,
  methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

// An Origin is compared as a bare scheme://host[:port] — browsers never put a
// path or trailing slash in one, but APP_URL/ALLOWED_ORIGINS are hand-written
// and routinely do ("https://example.com/"), which silently fails the exact
// match below and blocks a legitimately-configured origin.
function normalizeOrigin(value) {
  if (typeof value !== "string") return value;
  return value.trim().replace(/\/+$/, "");
}

// This server's own origin, derived from the request rather than from config.
// An Origin equal to the host the request was actually sent to IS same-origin:
// browsers never let page scripts forge Host or Origin, so a cross-site
// attacker can't make these match — they'd have to already be on this origin,
// at which point CORS was never the control protecting anything.
//
// This exists because config alone cannot be relied on to cover it. Confirmed
// live (2026-09-22, from production): APP_URL resolves to the public app
// domain (flashdelivery.co.za), NOT to this backend's own origin, which is
// where AdminJS is actually served. So every fetch-based admin action —
// bulk delete, edit/save, the custom approve/reject/acknowledge/resolve
// actions — was being rejected with "Not allowed by CORS", while plain page
// loads kept working because navigations send no Origin header at all.
// Deriving it from the request means a future redeploy, domain change or
// env-var edit can't silently reintroduce this.
function getSelfOrigin(req) {
  const host = req.headers.host;
  if (!host) return null;
  const forwardedProto = req.headers["x-forwarded-proto"];
  const proto =
    (forwardedProto ? String(forwardedProto).split(",")[0].trim() : req.protocol) ||
    "https";
  return `${proto}://${host}`;
}

// Real origin allowlist check (APP_URL, ALLOWED_ORIGINS, or dev defaults).
// Note APP_URL is NOT necessarily this backend's own origin (see
// getSelfOrigin above) — it's whatever the deployment points at, so it's
// treated as just another configured entry, not as self.
function isOriginAllowed(origin) {
  let allowedOrigins = [];

  if (process.env.APP_URL) {
    allowedOrigins.push(process.env.APP_URL);
  }

  if (process.env.ALLOWED_ORIGINS) {
    allowedOrigins.push(
      ...process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim()),
    );
  } else if (isDev) {
    // Development defaults - permissive for easier local testing.
    allowedOrigins.push(
      "http://localhost:3000",
      "http://localhost:3001",
      "http://localhost:8081", // React Native dev
      "http://localhost:19002", // Expo
      "http://127.0.0.1:3000",
      "http://127.0.0.1:3001",
      "http://127.0.0.1:8081",
      "http://127.0.0.1:19002",
    );
    console.log("[CORS] Using development defaults. Set ALLOWED_ORIGINS to control.");
  } else {
    console.warn(
      "[CORS] ALLOWED_ORIGINS not configured. CORS will block all requests.",
    );
  }

  if (allowedOrigins.map(normalizeOrigin).includes(normalizeOrigin(origin))) {
    return true;
  }
  if (!isProd) {
    console.warn(`[CORS] Request from unauthorized origin: ${origin}`);
    return true; // Development: forgiving, but logged.
  }
  return false;
}

// FLASH — RESPONSIVE/SECURITY AUDIT FIX: the "treat Origin: null as
// trusted" exception (2026-07-26, added because browsers send this exact
// literal string — not a missing header — for AdminJS's own bundled-
// frontend login POST to /admin-panel/login) was correct on its own, but
// this file used to apply `credentials: true` globally to every origin it
// allowed, including "null". That combination is a well-known, real CORS
// vulnerability: a page running in ITS OWN sandboxed iframe (or a file://
// page, or certain redirect chains) also sends a literal Origin: null. If
// this server reflects Access-Control-Allow-Origin: null together with
// Access-Control-Allow-Credentials: true, a browser treats that as a
// match and lets that unrelated malicious page's script read a
// credentialed (cookie-bearing) response — meaning it could ride the
// founder's own real, already-logged-in adminjs session cookie to read
// or act on real admin-panel data, with no other interaction needed.
//
// The original bug was a plain HTML <form> POST (AdminJS's login page) —
// full-page navigations and form submissions aren't subject to CORS
// response-reading rules at all, so Access-Control-Allow-Credentials has
// no bearing on whether that POST's Set-Cookie is honored; only genuine
// fetch/XHR-style cross-origin reads need it. So the null-origin case
// below still gets `origin: true` (preserving the original fix — the
// request isn't blocked) but with credentials explicitly turned off,
// closing the exploitable combination without reopening the original bug.
// Verified live after this change: admin login still succeeds normally.
const corsOptionsDelegate = function (req, callback) {
  const origin = req.headers.origin;

  // No Origin header at all (mobile apps, curl, Postman, server-to-server)
  // — nothing to reflect, and no browser CORS enforcement applies anyway.
  if (!origin) {
    return callback(null, { ...baseCorsOptions, origin: true });
  }

  if (origin === "null") {
    return callback(null, { ...baseCorsOptions, origin: true, credentials: false });
  }

  // Same-origin: the admin panel calling the backend that serves it. Keeps
  // credentials on — AdminJS's session cookie rides these requests.
  const selfOrigin = getSelfOrigin(req);
  if (selfOrigin && normalizeOrigin(origin) === normalizeOrigin(selfOrigin)) {
    return callback(null, { ...baseCorsOptions, origin: true });
  }

  const allowed = isOriginAllowed(origin);
  if (!allowed && isProd) {
    return callback(new Error("Not allowed by CORS"));
  }
  return callback(null, { ...baseCorsOptions, origin: allowed });
};

const corsMiddleware = cors(corsOptionsDelegate);

module.exports = { corsMiddleware };
