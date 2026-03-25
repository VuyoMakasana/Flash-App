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
  max: parseInt(process.env.DB_POOL_MAX || "20"),
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
