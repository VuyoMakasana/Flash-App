const { Pool } = require("pg");
const { getRequired, validateDatabaseURL } = require("./env");

// Validate DATABASE_URL configuration
const dbUrl = process.env.DATABASE_URL;
const isValid = validateDatabaseURL(dbUrl, "database");

if (!isValid && process.env.NODE_ENV === "production") {
  throw new Error(
    "[Database] CRITICAL: database connection misconfigured. Set DATABASE_URL environment variable.",
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
    console.log("[Database] ✅ Connection pool initialized successfully");
  })
  .catch((err) => {
    const msg = `[Database] ⚠️  Failed to verify connection: ${err.message}`;
    if (process.env.NODE_ENV === "production") {
      console.error(msg);
    } else {
      console.warn(msg);
    }
  });

module.exports = pool;
