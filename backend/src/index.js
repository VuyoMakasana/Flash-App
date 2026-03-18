require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');
const pool = require('./db/pool');

const authRoutes         = require('./routes/auth');
const userRoutes         = require('./routes/users');
const driverRoutes       = require('./routes/drivers');
const orderRoutes        = require('./routes/orders');
const paymentRoutes      = require('./routes/payments');
const trackingRoutes     = require('./routes/tracking');
const adminRoutes        = require('./routes/admin');
const webhookRoutes      = require('./routes/webhooks');
const subscriptionRoutes = require('./routes/subscriptions');
const sizingRoutes       = require('./routes/sizing');
const feedRoutes         = require('./routes/feed');
const boostRoutes        = require('./routes/boost');
const trendsRoutes       = require('./routes/trends');
const returnsRoutes      = require('./routes/returns');
const fleetRoutes        = require('./routes/fleet');
const inventoryRoutes    = require('./routes/inventory');
const messagesRoutes     = require('./routes/messages');
const trustedDriverRoutes = require('./routes/trustedDrivers');
const setupSocket        = require('./socket/socketServer');
const { runFleetIntelligence } = require('./routes/fleet');

const app = express();
const server = http.createServer(app);

// ─── SOCKET.IO + REDIS ADAPTER (Part 1 Fix 2) ────────────────────────────────
// Redis adapter lets Socket.io work across multiple backend instances.
// Falls back gracefully to in-memory if REDIS_URL is not set.
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
});

async function setupRedisAdapter() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl || redisUrl === 'disabled') {
    console.log('[Socket.io] In-memory adapter (single server). Set REDIS_URL to scale.');
    return;
  }
  try {
    const { createClient } = require('redis');
    const { createAdapter } = require('@socket.io/redis-adapter');
    const pubClient = createClient({ url: redisUrl });
    const subClient = pubClient.duplicate();
    await Promise.all([pubClient.connect(), subClient.connect()]);
    io.adapter(createAdapter(pubClient, subClient));
    console.log('[Socket.io] Redis adapter connected — multi-server mode enabled');
    pubClient.on('error', (err) => console.warn('[Redis pub]', err.message));
    subClient.on('error', (err) => console.warn('[Redis sub]', err.message));
  } catch (err) {
    console.warn('[Socket.io] Redis unavailable, using in-memory:', err.message);
  }
}

app.set('io', io);
app.use(helmet());
app.use(cors({ origin: '*' }));

// Webhooks need raw body BEFORE express.json()
app.use('/api/webhooks', express.raw({ type: 'application/json' }), webhookRoutes);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Use 'tiny' in production — 'combined' generates ~200 bytes per request
// At 20k users doing 5 req/min = 100k req/min = 20MB/min of log data in memory
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan(process.env.NODE_ENV === 'production' ? 'tiny' : 'combined'));
}

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false });
app.use('/api/', limiter);

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { error: 'Too many attempts, please try again later.' } });
app.use('/api/auth/', authLimiter);

// ─── ROUTES ───────────────────────────────────────────────────────────────────
app.use('/api/auth',            authRoutes);
app.use('/api/users',           userRoutes);
app.use('/api/drivers',         driverRoutes);
app.use('/api/orders',          orderRoutes);
app.use('/api/payments',        paymentRoutes);
app.use('/api/tracking',        trackingRoutes);
app.use('/api/admin',           adminRoutes);
app.use('/api/subscriptions',   subscriptionRoutes);
app.use('/api/sizing',          sizingRoutes);
app.use('/api/feed',            feedRoutes);
app.use('/api/boost',           boostRoutes);
app.use('/api/trends',          trendsRoutes);
app.use('/api/returns',         returnsRoutes);
app.use('/api/fleet',           fleetRoutes);
app.use('/api/inventory',       inventoryRoutes);
app.use('/api/messages',        messagesRoutes);
app.use('/api/trusted-drivers', trustedDriverRoutes);

app.get('/health', (req, res) => res.json({
  status: 'ok', version: '3.0.0', timestamp: new Date().toISOString(),
}));

app.use((req, res) => res.status(404).json({ error: 'Route not found' }));
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.statusCode || 500).json({
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
  });
});

setupSocket(io);

// ─── FLEET INTELLIGENCE every 5 min ──────────────────────────────────────────
setInterval(() => {
  runFleetIntelligence(io)
    .then(c => c.length && console.log(`[Fleet] ${c.length} cluster(s) found`))
    .catch(e => console.warn('[Fleet]', e.message));
}, 5 * 60 * 1000);

// ─── PART 1 FIX 3: Daily cleanup cron jobs ───────────────────────────────────
// Delete driver location history older than 30 days (runs 3:00am daily)
cron.schedule('0 3 * * *', async () => {
  try {
    const r = await pool.query(`DELETE FROM driver_locations WHERE recorded_at < NOW() - INTERVAL '30 days'`);
    console.log(`[Cron] Pruned ${r.rowCount} old driver_locations rows`);
  } catch (e) { console.warn('[Cron] location cleanup error:', e.message); }
});

// Delete browsing events older than 60 days (runs 3:30am daily)
cron.schedule('30 3 * * *', async () => {
  try {
    const r = await pool.query(`DELETE FROM browsing_events WHERE created_at < NOW() - INTERVAL '60 days'`);
    console.log(`[Cron] Pruned ${r.rowCount} old browsing_events rows`);
  } catch (e) { console.warn('[Cron] browsing cleanup error:', e.message); }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log(`\n Flash Backend v3.0 on port ${PORT}`);
  await setupRedisAdapter();
  console.log(`Cleanup cron scheduled (daily 3am)\n`);
});

// ─── GRACEFUL SHUTDOWN ────────────────────────────────────────────────────────
// On SIGTERM (Render, Docker): stop accepting new requests, finish in-flight ones,
// then close the DB pool cleanly. Prevents "connection closed unexpectedly" errors.
async function gracefulShutdown(signal) {
  console.log(`\n[${signal}] Starting graceful shutdown...`);
  server.close(async () => {
    try {
      await pool.end();
      console.log('[Shutdown] DB pool closed. Goodbye.');
    } catch (e) {
      console.warn('[Shutdown] pool.end error:', e.message);
    }
    process.exit(0);
  });
  // Force exit if shutdown takes longer than 10 seconds
  setTimeout(() => { console.error('[Shutdown] Timeout — forcing exit'); process.exit(1); }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

// Catch unhandled promise rejections — log them but don't crash the server
process.on('unhandledRejection', (reason) => {
  console.error('[UnhandledRejection]', reason);
});

module.exports = { app, server, io };
