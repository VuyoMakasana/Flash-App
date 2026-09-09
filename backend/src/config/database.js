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
  // LOWERED: DB pool max from 50 back down to 30 (§2.11 audit).
  // WHY: the 50 figure (itself raised from an original 20, reasoning: "100
  // concurrent users each holding a connection during a 2-3 second Paystack
  // call") was never checked against the real ceiling -- Supabase's free
  // tier caps at 60 total connections platform-wide, shared with Supabase's
  // own internal use, any dashboard session, and any migration/admin script
  // run concurrently. 50 left almost no headroom under that cap even with a
  // single backend instance (confirmed live: this project is genuinely on
  // the free plan, not hypothetical), and a second Render instance would
  // have overflowed it outright (each instance opens its own pool, so two
  // instances at 50 each needs 100). 30 keeps real headroom under 60 while
  // still comfortably covering this app's actual concurrent load at current
  // and near-term traffic (a few hundred orders/day doesn't produce
  // anywhere near 30 simultaneous Paystack-call-holding requests) -- not a
  // hard technical ceiling, just deliberately not run up against the real
  // one. Revisit alongside DB_POOL_MAX if a second instance is ever added.
  max: parseInt(process.env.DB_POOL_MAX || "30"),
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
