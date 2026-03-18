const { Pool } = require('pg');

// At 20,000 users the default pool of 20 connections queues requests.
// Render Standard gives you a single server; Supabase Pro allows 60 connections.
// max: 20 is safe for Render free/starter. Raise to 50 on Render Standard or dedicated DB.
// Do NOT set above your Postgres server's max_connections setting.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: parseInt(process.env.DB_POOL_MAX || '20'),        // override via env without code change
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,   // was 2000 — give a bit more room under burst load
  allowExitOnIdle: false,
});

pool.on('error', (err) => {
  // Log but do NOT crash the process — pg emits this for idle client errors
  console.error('[Pool] Idle client error:', err.message);
});

pool.on('connect', () => {
  // Optional: track active connections for monitoring
});

module.exports = pool;
