'use strict';

const jwt  = require('jsonwebtoken');
const { getRequired } = require('../config/env');
const pool = require('../config/database');

// ─────────────────────────────────────────────────────────────────────────────
// In-memory rate limiter for Socket.IO events.
// Express rate-limit doesn't cover socket events, so we maintain a simple
// per-socket, per-event sliding window counter.
// ─────────────────────────────────────────────────────────────────────────────
function createSocketRateLimiter(maxEvents, windowMs) {
  // Map<socketId, { count, resetAt }>
  const counters = new Map();

  // Clean up stale entries every windowMs to avoid unbounded memory growth
  setInterval(() => {
    const now = Date.now();
    for (const [id, state] of counters.entries()) {
      if (now >= state.resetAt) counters.delete(id);
    }
  }, windowMs);

  return function isAllowed(socketId) {
    const now = Date.now();
    const state = counters.get(socketId);

    if (!state || now >= state.resetAt) {
      counters.set(socketId, { count: 1, resetAt: now + windowMs });
      return true;
    }

    if (state.count >= maxEvents) {
      return false;
    }

    state.count += 1;
    return true;
  };
}

// driver_location_update: max 60 events per minute (≈1/second)
const locationRateAllowed = createSocketRateLimiter(60, 60_000);

// General socket events: max 120 per minute
const generalRateAllowed  = createSocketRateLimiter(120, 60_000);

// ─────────────────────────────────────────────────────────────────────────────

async function canAccessOrderRoom(orderId, userId, userRole) {
  if (!orderId || !userId || !userRole) return false;
  const result = await pool.query(
    `SELECT user_id, driver_id FROM orders WHERE id = $1`,
    [orderId],
  );
  if (!result.rows.length) return false;
  if (userRole === 'admin')  return true;
  if (userRole === 'user')   return String(result.rows[0].user_id)   === String(userId);
  if (userRole === 'driver') return String(result.rows[0].driver_id) === String(userId);
  return false;
}

module.exports = function setupSocket(io) {
  const jwtSecret = getRequired('JWT_SECRET', 'socket');

  // ── AUTH MIDDLEWARE ────────────────────────────────────────────────────────
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Authentication required'));

    try {
      const decoded = jwt.verify(token, jwtSecret);

      if (decoded.jti) {
        const { rows } = await pool.query(
          `SELECT 1 FROM revoked_tokens WHERE jti = $1`,
          [decoded.jti],
        );
        if (rows.length) return next(new Error('Token revoked'));
      }

      socket.userId     = decoded.id;
      socket.userRole   = decoded.role;
      socket.userStatus = decoded.status || null;

      next();
    } catch (err) {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    socket.join(`${socket.userRole}:${socket.userId}`);

    // ── USER: Track an order ────────────────────────────────────────────────
    socket.on('track_order', async ({ orderId }) => {
      if (!generalRateAllowed(socket.id)) return;
      if (
        socket.userRole === 'user' &&
        (await canAccessOrderRoom(orderId, socket.userId, socket.userRole))
      ) {
        socket.join(`order:${orderId}`);
        socket.join(`chat:${orderId}`);
      }
    });

    socket.on('stop_tracking', ({ orderId }) => {
      socket.leave(`order:${orderId}`);
      socket.leave(`chat:${orderId}`);
    });

    // ── DRIVER: Live location update ─────────────────────────────────────────
    // RATE LIMITED: max 60 events per minute per socket (one per second).
    // Excess events are silently dropped — the client does not need an error.
    socket.on('driver_location_update', async ({ lat, lng, orderId }) => {
      if (socket.userRole !== 'driver') return;

      // Rate check — enforce before any DB work
      if (!locationRateAllowed(socket.id)) return;

      if (orderId && !(await canAccessOrderRoom(orderId, socket.userId, socket.userRole))) return;

      const payload = { driverId: socket.userId, lat, lng, timestamp: new Date().toISOString() };
      if (orderId) io.to(`order:${orderId}`).emit('driver_location', payload);
      io.to('admin').emit('driver_location', { ...payload, orderId });
    });

    // ── DRIVER: Online / offline status ────────────────────────────────────
    socket.on('driver_status', ({ online }) => {
      if (socket.userRole !== 'driver') return;
      if (!generalRateAllowed(socket.id)) return;
      io.to('admin').emit('driver_status_change', {
        driverId: socket.userId,
        online,
        timestamp: new Date().toISOString(),
      });
    });

    // ── DRIVER: Join / leave the order pool ────────────────────────────────
    socket.on('join_driver_pool', () => {
      if (socket.userRole === 'driver') {
        socket.join('driver_pool');
        socket.join(`driver:${socket.userId}`);
      }
    });

    socket.on('leave_driver_pool', () => {
      socket.leave('driver_pool');
    });

    // ── DRIVER: Join order chat room ───────────────────────────────────────
    socket.on('join_order_chat', async ({ orderId }) => {
      if (!generalRateAllowed(socket.id)) return;
      if (
        (socket.userRole === 'driver' || socket.userRole === 'user') &&
        (await canAccessOrderRoom(orderId, socket.userId, socket.userRole))
      ) {
        socket.join(`order:${orderId}`);
        socket.join(`chat:${orderId}`);
      }
    });

    socket.on('leave_order_chat', ({ orderId }) => {
      socket.leave(`chat:${orderId}`);
    });

    // ── FLEET alert acknowledgement ────────────────────────────────────────
    socket.on('ack_fleet_alert', ({ alertId }) => {
      if (socket.userRole !== 'admin') return;
      if (!generalRateAllowed(socket.id)) return;
      io.to('admin').emit('fleet_alert_acked', {
        alertId,
        ackedBy: socket.userId,
        timestamp: new Date().toISOString(),
      });
    });

    socket.on('disconnect', () => {
      // Cleanup is handled by Socket.IO automatically
    });
  });
};
