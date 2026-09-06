const { Pool } = require("pg");
const { getRequired, validateDatabaseURL, isKnownProductionDatabaseUrl } = require("./env");

// Validate DATABASE_URL configuration
const dbUrl = process.env.DATABASE_URL;
const isValid = validateDatabaseURL(dbUrl, "database");

if (!isValid && process.env.NODE_ENV === "production") {
  throw new Error(
    "[Database] CRITICAL: database connection misconfigured. Set DATABASE_URL environment variable.",
  );
}

// Phase 0.5 remediation -- refuses to even open a pool against the real
// production database from anything that isn't genuinely running on
// Render's own infrastructure. This is exactly the gap found live during
// the pre-implementation audit: local development (and this session's own
// testing) was connecting straight to production with zero separation and
// zero warning.
//
// Deliberately keyed on process.env.RENDER, not NODE_ENV -- confirmed live
// (see the failed first attempt at this exact guard) that backend/.env has
// NODE_ENV=production sitting in it for local development too, which would
// have silently defeated a NODE_ENV-based check for the one environment
// this most needed to catch. RENDER=true is set automatically by Render on
// every single deployed service (https://render.com/docs/environment-
// variables) -- nobody sets it by hand, nothing to accidentally copy into
// a local .env, so it's a genuine "am I really on Render" signal rather
// than a self-reported flag that already proved unreliable here.
//
// The override exists for real, deliberate exceptions (a one-off admin/
// migration script meant to run against production from off-Render) --
// named to require someone to type out what they're doing, not a terse
// flag a script could set by habit.
if (isKnownProductionDatabaseUrl(dbUrl) && process.env.RENDER !== "true") {
  if (process.env.I_UNDERSTAND_THIS_CONNECTS_TO_PRODUCTION !== "true") {
    throw new Error(
      "[Database] REFUSING TO START: DATABASE_URL points at the real production database, " +
      "but this process is not running on Render (RENDER env var not set). This is almost " +
      "always an accident -- e.g. a local .env still pointed at production with nothing to " +
      "distinguish it from a dev/staging instance. If this is genuinely intentional (a " +
      "one-off script meant to run against production from outside Render), set " +
      "I_UNDERSTAND_THIS_CONNECTS_TO_PRODUCTION=true and run it again.",
    );
  }
  console.warn(
    "[Database] WARNING: connected to the real production database from off-Render " +
    "(I_UNDERSTAND_THIS_CONNECTS_TO_PRODUCTION=true was set). Proceed with care.",
  );
}

// Create pool with configuration
const pool = new Pool({
  connectionString: dbUrl,
  // INCREASED: DB pool max from 20 to 50
  // WHY: At 20 connections with 100 concurrent users each holding a connection
  // during a 2-3 second Paystack API call, the pool exhausts and new requests
  // queue or time out. 50 is safer for early production traffic.
  max: parseInt(process.env.DB_POOL_MAX || "50"),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  allowExitOnIdle: false,
});

pool.on("error", (err) => {
  console.error("[Pool] Idle client error:", err.message);
});

// Verify connection on startup (non-blocking)
pool
  .query("SELECT 1")
  .then(() => {
    console.log("[Database] Connection pool initialized successfully");
  })
  .catch((err) => {
    const msg = `[Database] Failed to verify connection: ${err.message}`;
    if (process.env.NODE_ENV === "production") {
      console.error(msg);
    } else {
      console.warn(msg);
    }
  });

module.exports = pool;
