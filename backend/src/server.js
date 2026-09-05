// src/server.js
require("dotenv").config();
const cron = require("node-cron");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const helmet = require("helmet");
const pinoHttp = require("pino-http");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

// ADDED: Sentry error monitoring — previously the backend had zero crash reporting.
// Any unhandled error in production was invisible. Sentry captures all errors and
// sends alerts so issues are caught before customers complain.
const Sentry = require('@sentry/node');
if (process.env.SENTRY_DSN && process.env.NODE_ENV === 'production') {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV,
    tracesSampleRate: 0.1,
    sendDefaultPii: false,
    // Same standard as pino-http's redact list a few lines below (the C-1
    // fix) — this is the single place that owns what Sentry is allowed to
    // keep. Recursive, not just top-level of each object passed in —
    // caught during live verification that a single-level scrub misses a
    // sensitive key nested one level deeper (e.g. contexts.session.cookie),
    // silently letting it through.
    beforeSend(event) {
      const SENSITIVE_KEY = /^(authorization|cookie)$/i;
      const scrub = (obj, seen = new WeakSet()) => {
        if (!obj || typeof obj !== "object" || seen.has(obj)) return;
        seen.add(obj);
        for (const key of Object.keys(obj)) {
          if (SENSITIVE_KEY.test(key)) {
            delete obj[key];
          } else if (obj[key] && typeof obj[key] === "object") {
            scrub(obj[key], seen);
          }
        }
      };
      scrub(event.request);
      scrub(event.extra);
      return event;
    },
  });
}

const requiredEnv = ["DATABASE_URL", "JWT_SECRET"];
const missingEnv = requiredEnv.filter((name) => !process.env[name]);
if (missingEnv.length) {
  throw new Error(
    `[Config] Missing required environment variable(s): ${missingEnv.join(", ")}`,
  );
}

const pool = require("./config/database");
const logger = require("./config/logger");
const { errorHandler, notFound } = require("./middleware/errorHandler");
const {
  limiter,
  authLimiter,
} = require("./middleware/rateLimiter");
const { corsMiddleware } = require("./middleware/cors");
const { redisClient } = require("./middleware/cache");
const setupSocket = require("./socket/socketServer");
const {
  reconcilePendingPayments,
  reconcileStuckRefunds,
  reconcileMissingRefunds,
} = require("./services/paymentReconciliationJob");

// Import routes
const authRoutes = require("./routes/authRoutes");
const userRoutes = require("./routes/userRoutes");
const driverRoutes = require("./routes/driverRoutes");
const orderRoutes = require("./routes/orderRoutes");
const paymentRoutes = require("./routes/paymentRoutes");
const trackingRoutes = require("./routes/trackingRoutes");
const adminRoutes = require("./routes/adminRoutes");
const webhookRoutes = require("./routes/webhookRoutes");
const subscriptionRoutes = require("./routes/subscriptionRoutes");
const sizingRoutes = require("./routes/sizingRoutes");
const feedRoutes = require("./routes/feedRoutes");
const boostRoutes = require("./routes/boostRoutes");
const trendsRoutes = require("./routes/trendsRoutes");
const returnsRoutes = require("./routes/returnRoutes");
const fleetRoutes = require("./routes/fleetRoutes");
const inventoryRoutes = require("./routes/inventoryRoutes");
const messagesRoutes = require("./routes/messageRoutes");
const trustedDriverRoutes = require("./routes/trustedDriverRoutes");
const sosRoutes = require("./routes/sosRoutes");
const marketingRoutes = require("./routes/marketingRoutes");

function createApp() {
  const app = express();
  // Trust reverse proxy headers in production deployments (Render/Railway/Nginx).
  if (process.env.NODE_ENV === "production") {
    app.set("trust proxy", 1);
  }

  const server = http.createServer(app);

  // Socket.IO CORS: in production, restrict to known app URLs.
  // Mobile apps (Expo Go / native) don't send an Origin header so they always pass through.
  // The wildcard is only dangerous for browser-based attackers, not mobile clients.
  const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
    : ['https://flash-app-hplc.onrender.com'];

  const io = new Server(server, {
    cors: {
      origin: process.env.NODE_ENV === 'production'
        ? (origin, cb) => {
            // Mobile apps send no origin — always allow
            if (!origin) return cb(null, true);
            if (allowedOrigins.includes(origin)) return cb(null, true);
            cb(new Error(`Socket CORS blocked: ${origin}`));
          }
        : '*',
      methods: ['GET', 'POST'],
    },
    maxHttpBufferSize: 1e6,
    perMessageDeflate: false,
    pingTimeout:  60000,
    pingInterval: 25000,
  });

  app.set("io", io);

// Security middleware
  app.use(helmet());
  app.use(corsMiddleware);

// Minimal standalone admin page (login + pending-returns queue + approve/
// reject/finalize) — there is no admin dashboard/app anywhere else in this
// codebase. A static page served same-origin so it works cleanly under
// helmet's default CSP (script-src 'self') with no inline scripts and no
// CSP relaxation needed; it calls the existing /api/admin and /api/returns
// endpoints directly via fetch().
  app.use("/admin", express.static(path.join(__dirname, "..", "public", "admin")));

// Webhook routes: each route applies its own body parser (raw for Paystack,
// JSON for Payflex) so we mount the router directly without global raw parsing.
  app.use("/api/webhooks", webhookRoutes);

// Admin panel (AdminJS) mount point — same reason as webhooks immediately
// above: AdminJS's own login form uses express-formidable to read the raw
// request body itself, which fails once the global express.json() below has
// already consumed it (confirmed live: "You probably used old body-parser
// middleware, which is not compatible with @adminjs/express" — AdminJS's own
// error message for exactly this ordering mistake). Registered as an empty
// placeholder router here, before the global body parser AND before
// notFound/errorHandler; routes added to this same router object later
// (once startServer()'s async mountAdminPanel() finishes) are reachable
// immediately, since Express resolves a mounted router's contents at
// request time, not at mount time — this doesn't require createApp()
// itself to become async. Anything hitting /admin-panel before that
// finishes (or in a test/mock-server context that never calls
// mountAdminPanel at all) correctly falls through to notFound, same as today.
  const adminPanelRouter = express.Router();
  app.locals.adminPanelRouter = adminPanelRouter;
  app.use("/admin-panel", adminPanelRouter);

// Body parsing
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true }));

// Logging — structured JSON, with a request ID (req.id) attached to every
// log line for a given request, including anything logged via req.log
// inside a route handler. Replaces morgan's plain-text access log.
  app.use(pinoHttp({
    logger,
    redact: ["req.headers.authorization", "req.headers.cookie"],
  }));

// Rate limiting
  app.use("/api/", limiter);
  app.use("/api/auth/", authLimiter);
  // orderLimiter (order-creation-specific, 5/min) is applied directly on
  // POST /api/orders in orderRoutes.js, not here -- see that file's comment.

// Routes
  app.use("/api/auth", authRoutes);
  app.use("/api/users", userRoutes);
  app.use("/api/drivers", driverRoutes);
  app.use("/api/orders", orderRoutes);
  app.use("/api/payments", paymentRoutes);
  app.use("/api/tracking", trackingRoutes);
  app.use("/api/admin", adminRoutes);
  app.use("/api/subscriptions", subscriptionRoutes);
  app.use("/api/sizing", sizingRoutes);
  app.use("/api/feed", feedRoutes);
  app.use("/api/boost", boostRoutes);
  app.use("/api/trends", trendsRoutes);
  app.use("/api/returns", returnsRoutes);
  app.use("/api/fleet", fleetRoutes);
  app.use("/api/inventory", inventoryRoutes);
  app.use("/api/messages", messagesRoutes);
  app.use("/api/trusted-drivers", trustedDriverRoutes);
  app.use("/api/sos", sosRoutes);
// Public marketing-site forms (waitlist, contact, driver/seller applications)
// — no auth, same as flash-website-rebuild's original standalone backend;
// mounted at /api directly since the frontend already calls /api/waitlist,
// /api/contact, /api/applications/driver, /api/applications/seller.
  app.use("/api", marketingRoutes);

// Health check — previously always returned status: "ok" unconditionally,
// with no actual check of either dependency. That made it useless for real
// incident response: it would report healthy even with the DB or Redis down.
  app.get("/health", async (req, res) => {
    const checks = { database: "unknown", redis: "unknown" };
    let healthy = true;

    try {
      await pool.query("SELECT 1");
      checks.database = "ok";
    } catch (err) {
      checks.database = "error";
      healthy = false;
    }

    if (!redisClient) {
      checks.redis = "not_configured";
    } else {
      try {
        await redisClient.ping();
        checks.redis = "ok";
      } catch (err) {
        // Redis backs caching and distributed rate limiting, both of which
        // already fall back gracefully (cache.js skips itself; rateLimiter.js
        // falls back to an in-memory store) — its outage degrades
        // performance but doesn't take the API down, so it doesn't flip
        // overall health to unhealthy the way a DB failure does.
        checks.redis = "error";
      }
    }

    res.status(healthy ? 200 : 503).json({
      status: healthy ? "ok" : "unhealthy",
      version: "3.0.0",
      timestamp: new Date().toISOString(),
      checks,
    });
  });

  // Operating hours status — used by both apps to show open/closed banner
  app.get("/api/status/hours", (req, res) => {
    const { isWithinOperatingHours, getNextOpenTime } = require('./services/operatingHoursService');
    const open = isWithinOperatingHours();
    res.json({
      open,
      openHour: '07:00',
      closeHour: '19:00',
      timezone: 'SAST (UTC+2)',
      nextOpenAt: open ? null : getNextOpenTime().toISOString(),
      message: open
        ? 'Flash is open for deliveries'
        : 'Flash is closed. Orders placed now will be delivered from 07:00.',
    });
  });

// 404 and error handlers
  app.use(notFound);
  app.use(errorHandler);

// Setup Socket.IO
  setupSocket(io);


// Capture io for use in crons — avoids referencing 'runtime' before assignment
let _io = io;

    // ADDED: Redis adapter for Socket.IO — activates when REDIS_URL is set
    // WHY: Without Redis, running two backend instances causes socket events (driver
    // location, order updates) to only reach users connected to the same instance.
    // Redis makes socket events broadcast across all instances.
    if (process.env.REDIS_URL && process.env.REDIS_URL !== 'disabled') {
      const { createAdapter } = require('@socket.io/redis-adapter');
      const { createClient } = require('redis');
      (async () => {
        try {
          const pubClient = createClient({ url: process.env.REDIS_URL });
          const subClient = pubClient.duplicate();
          await Promise.all([pubClient.connect(), subClient.connect()]);
          io.adapter(createAdapter(pubClient, subClient));
          console.log('[Redis]  Socket.IO Redis adapter connected');
        } catch (redisErr) {
          console.warn('[Redis]   Redis unavailable — running single-instance mode:', redisErr.message);
        }
      })();
    }

// Cron jobs
  cron.schedule("0 3 * * *", async () => {
    try {
      const r = await pool.query(
        `DELETE FROM driver_locations WHERE recorded_at < NOW() - INTERVAL '30 days'`,
      );
      console.log(`[Cron] Pruned ${r.rowCount} old driver_locations rows`);
    } catch (e) {
      console.warn("[Cron] location cleanup error:", e.message);
    }
  });

  cron.schedule("30 3 * * *", async () => {
    try {
      const r = await pool.query(
        `DELETE FROM browsing_events WHERE created_at < NOW() - INTERVAL '60 days'`,
      );
      console.log(`[Cron] Pruned ${r.rowCount} old browsing_events rows`);
    } catch (e) {
      console.warn("[Cron] browsing cleanup error:", e.message);
    }
  });

  cron.schedule("*/5 * * * *", async () => {
    try {
      await reconcilePendingPayments(io);
    } catch (e) {
      console.warn("[Cron] payment reconciliation error:", e.message);
    }
    try {
      await reconcileStuckRefunds();
    } catch (e) {
      console.warn("[Cron] stuck refund reconciliation error:", e.message);
    }
    try {
      await reconcileMissingRefunds(io);
    } catch (e) {
      console.warn("[Cron] missing refund reconciliation error:", e.message);
    }
  });

/*cron.schedule('0 3 * * *', async () => {
  try {
    await pool.query(`
      DELETE FROM revoked_tokens
      WHERE expires_at < NOW()
    `);

    console.log(
      '[CRON] Cleaned expired revoked tokens'
    );
  } catch (err) {
    console.error(
      '[CRON] Failed revoked token cleanup:',
      err.message
    );
  }
});
*/
  

  
 // Nightly at 03:30 SAST (01:30 UTC): purge expired tokens
// Without this, refresh_tokens and revoked_tokens grow forever and slow auth queries
cron.schedule('30 1 * * *', async () => {
  try {
    const r1 = await pool.query('DELETE FROM refresh_tokens WHERE expires_at < NOW()');
    const r2 = await pool.query('DELETE FROM revoked_tokens WHERE expires_at < NOW()');
    console.log(`[TokenCleanup] Deleted ${r1.rowCount} refresh + ${r2.rowCount} revoked tokens`);
  } catch (e) {
    console.warn('[TokenCleanup] Error:', e.message);
  }
}); 



  // OPERATING HOURS: Every day at 07:00 SAST (05:00 UTC), release all orders
  // that were placed overnight and are waiting in 'scheduled_for_morning'.
  // These are converted to 'pending_store_acceptance', not directly to
  // 'waiting_for_driver' -- an order placed overnight still needs the same
  // real store accept/reject gate once the store opens
  // (docs/audits/FLASH_STORE_ADMIN_DESIGN.md §0), not a free pass into
  // driver matching just because of when it was placed.
  cron.schedule('0 5 * * *', async () => {
    try {
      const { updateOrderStatus } = require('./services/orderStateMachineService');
      const scheduledOrders = await pool.query(
        `SELECT id, user_id FROM orders
         WHERE status = 'scheduled_for_morning'
           AND (scheduled_for IS NULL OR scheduled_for <= NOW())`
      );
      for (const order of scheduledOrders.rows) {
        try {
          await updateOrderStatus(order.id, 'pending_store_acceptance', {
            actorId: 'system',
            actorRole: 'system',
            io: _io,
          });
          if (_io) {
            _io.to(`user:${order.user_id}`).emit('order_update', {
              orderId: order.id,
              status: 'pending_store_acceptance',
              message: 'Good morning! Flash is now open. Your order is being reviewed by the store.',
            });
          }
          console.log(`[OperatingHours] Released scheduled order ${order.id} for store acceptance`);
        } catch (e) {
          console.warn(`[OperatingHours] Failed to release order ${order.id}:`, e.message);
        }
      }
      console.log(`[OperatingHours] Released ${scheduledOrders.rows.length} scheduled orders at open`);
    } catch (e) {
      console.warn('[OperatingHours] Morning release cron error:', e.message);
    }
  });
  // WHY: Drivers can accept an order and go offline with no consequence. Orders would
  // stay stuck in driver_assigned forever with no customer alert and no resolution.
  cron.schedule('*/10 * * * *', async () => {
    try {
      // Find orders stuck in driver_assigned or driver_arrived_store for more than 45 minutes
      const stuckOrders = await pool.query(`
        SELECT o.id, o.driver_id, o.user_id, o.delivery_mode, o.status,
               o.driver_payout, o.delivery_fee,
               d.push_token as driver_push_token
        FROM orders o
        LEFT JOIN drivers d ON d.id = o.driver_id
        WHERE o.status IN ('driver_assigned', 'driver_arrived_store')
          AND o.updated_at < NOW() - INTERVAL '45 minutes'
          AND o.driver_id IS NOT NULL
      `);

      const { requeueOrderForDriverSearch } = require('./services/orderStateMachineService');
      const DriverWallet = require('./models/DriverWallet');
      const ioInstance = _io;

      for (const order of stuckOrders.rows) {
        try {
          // Requeue and the driver's pending-wallet reversal now share one
          // transaction (same externalClient pattern as
          // orderController.cancelOrder / driverController.cancelAssignedOrder)
          // — previously these were two separate transactions, so a crash
          // between them could reverse the driver's pending payout while the
          // order stayed assigned to a driver who just timed out, or requeue
          // the order while leaving pending_balance permanently uncorrected.
          const payout = parseFloat(order.driver_payout || order.delivery_fee || 0);
          const client = await pool.connect();
          try {
            await client.query('BEGIN');

            // Re-queue through the state machine FIRST: this takes a row lock
            // and re-validates the order is still driver_assigned/driver_arrived_store,
            // so a driver's in-flight status update (e.g. just tapped "Picked Up")
            // can't be clobbered by this cron. If the order has already moved
            // on, this throws and the whole transaction rolls back below — no
            // penalty, no wallet change — because the driver did not actually
            // go unavailable.
            await requeueOrderForDriverSearch(
              order.id,
              { actorId: 'system', actorRole: 'system' },
              client,
            );

            if (payout > 0) {
              await DriverWallet.reversePending(
                client, order.driver_id, payout, order.id, 'driver_timeout_reassigned',
              );
            }

            await client.query('COMMIT');
          } catch (err) {
            await client.query('ROLLBACK');
            throw err;
          } finally {
            client.release();
          }

          // Penalise the driver — increment cancel count
          await pool.query(
            `UPDATE drivers SET cancel_count = COALESCE(cancel_count, 0) + 1, updated_at = NOW() WHERE id = $1`,
            [order.driver_id]
          );

          // Auto-suspend driver if cancel count reaches 5
          const driverCheck = await pool.query(
            `SELECT cancel_count FROM drivers WHERE id = $1`, [order.driver_id]
          );
          if ((driverCheck.rows[0]?.cancel_count || 0) >= 5) {
            await pool.query(
              `UPDATE drivers SET is_online = false, status = 'suspended', updated_at = NOW() WHERE id = $1`,
              [order.driver_id]
            );
            console.warn(`[Cron] Driver ${order.driver_id} auto-suspended after 5 cancellations`);
          }

          // Notify user with a friendlier message than the generic order_update.
          // Side effects here only fire after the transaction above has
          // committed (its own COMMIT/ROLLBACK already resolved above).
          if (ioInstance) {
            ioInstance.to(`user:${order.user_id}`).emit('order_update', {
              orderId: order.id,
              status: 'waiting_for_driver',
              message: 'Your driver became unavailable. Finding a new driver now.',
            });
          }

          // Attempt auto-reassign for fleet orders
          if (order.delivery_mode === 'fleet') {
            const { autoAssignNearestDriver } = require('./services/autoMatchService');
            await autoAssignNearestDriver(order.id, ioInstance).catch(() => null);
          }

          console.log(`[Cron] Auto-reassigned stuck order ${order.id} from driver ${order.driver_id}`);
        } catch (orderErr) {
          console.warn(`[Cron] Failed to reassign order ${order.id}:`, orderErr.message);
        }
      }
    } catch (e) {
      console.warn('[Cron] Stuck order detection error:', e.message);
    }
  });

  // DRIVER-CONNECTION-LOST DETECTION: Runs every 10 minutes
  // WHY (critical-flow/edge-case audit §2.2): the reassignment cron above
  // only covers driver_assigned/driver_arrived_store (pre-pickup) — once
  // picked_up, the physical item is with that specific driver, so
  // auto-reassigning the order doesn't make physical sense, and nothing
  // detects the driver going silent (phone dies, loses connectivity)
  // either way. Same flag-for-review mechanism as the stuck-at-delivered
  // cron below (idempotent, admin-panel visible, live fleet_alert) — a
  // distinct column since this is a distinct root cause. 25 minutes is
  // well past normal ping cadence (~15s per CLAUDE.md) and comfortably
  // inside the same order of magnitude as the pre-pickup cron's 45-minute
  // window, without waiting that long on an order already in progress.
  cron.schedule('*/10 * * * *', async () => {
    try {
      const staleActive = await pool.query(`
        SELECT o.id, o.order_number, o.driver_id, o.status
        FROM orders o
        JOIN drivers d ON d.id = o.driver_id
        WHERE o.status IN ('picked_up', 'in_transit')
          AND d.updated_at < NOW() - INTERVAL '25 minutes'
          AND o.driver_connection_flagged_at IS NULL
      `);

      for (const order of staleActive.rows) {
        await pool.query(
          `UPDATE orders SET driver_connection_flagged_at = NOW() WHERE id = $1`,
          [order.id],
        );
        console.warn(`[Cron] Order ${order.id} (${order.order_number}) — driver ${order.driver_id} hasn't sent a location update in over 25 minutes while ${order.status}. Flagged for admin review.`);
        if (_io) {
          _io.to('admin').emit('fleet_alert', {
            type: 'driver_connection_lost',
            orderId: order.id,
            orderNumber: order.order_number,
            message: `Order ${order.order_number}'s driver hasn't sent a location update in over 25 minutes while the order is ${order.status} — their connection may be lost.`,
          });
        }
      }
    } catch (e) {
      console.warn('[Cron] Driver-connection staleness detection error:', e.message);
    }
  });

  // STUCK-AT-DELIVERED DETECTION: Runs every 30 minutes
  // WHY (critical-flow/edge-case audit §2.1): the delivered->completed
  // transition requires a real OTP only the customer's own app can
  // retrieve (paymentController.confirmCashReceived verifies it
  // unconditionally, for both cash and card orders — confirmed live). If a
  // customer is genuinely unreachable specifically at the moment of
  // delivery and never reconnects, the order is stuck at 'delivered'
  // forever — no other timeout covers this (the cron above only covers
  // pre-pickup states), and the driver's payout for that delivery stays
  // pending indefinitely as a direct consequence (release is gated on
  // reaching 'completed'). This never auto-completes anything — it only
  // flags the order once, idempotently, mirroring the SOS-alert live-
  // notification pattern (io.to('admin').emit('fleet_alert', ...)) for
  // anyone with the panel open right now, plus a persistent, visible
  // column (orders.stuck_delivery_flagged_at) for anyone who isn't.
  cron.schedule('*/30 * * * *', async () => {
    try {
      const stuckDelivered = await pool.query(`
        SELECT id, order_number, driver_id
        FROM orders
        WHERE status = 'delivered'
          AND delivered_at < NOW() - INTERVAL '2 hours'
          AND stuck_delivery_flagged_at IS NULL
      `);

      for (const order of stuckDelivered.rows) {
        await pool.query(
          `UPDATE orders SET stuck_delivery_flagged_at = NOW() WHERE id = $1`,
          [order.id],
        );
        console.warn(`[Cron] Order ${order.id} (${order.order_number}) stuck at 'delivered' for over 2 hours — driver ${order.driver_id}'s payout is pending until resolved. Flagged for admin review.`);
        if (_io) {
          _io.to('admin').emit('fleet_alert', {
            type: 'stuck_delivery',
            orderId: order.id,
            orderNumber: order.order_number,
            message: `Order ${order.order_number} has been stuck at 'delivered' for over 2 hours — the customer may be unreachable to confirm delivery. The driver's payout is pending until this is resolved.`,
          });
        }
      }
    } catch (e) {
      console.warn('[Cron] Stuck-at-delivered detection error:', e.message);
    }
  });

  // NO-DRIVER AUTO-CANCEL: Runs every 15 minutes
  // WHY: When a user pays and no drivers are available, their money is trapped
  // in a pending order with no resolution. After 30 minutes in waiting_for_driver
  // we automatically cancel and trigger a full refund so users are not left stranded.
  cron.schedule('*/15 * * * *', async () => {
    try {
      const stuckPaidOrders = await pool.query(`
        SELECT o.id, o.user_id, o.payment_method, o.payment_status, o.total
        FROM orders o
        WHERE o.status = 'waiting_for_driver'
          AND o.payment_status = 'paid'
          AND o.updated_at < NOW() - INTERVAL '30 minutes'
          AND o.driver_id IS NULL
      `);

      for (const order of stuckPaidOrders.rows) {
        try {
          const { updateOrderStatus } = require('./services/orderStateMachineService');
          const RefundService = require('./services/refundService');
          const pool2 = require('./config/database');
          const ioInstance = _io;

          await pool2.query(
            `INSERT INTO order_cancellations (order_id, cancelled_by_role, reason, refund_mode)
 VALUES ($1, 'system', 'no_driver_available_timeout', 'full_refund')`,
[order.id]
          );

          await updateOrderStatus(order.id, 'cancelled', {
            actorId: 'system',
            actorRole: 'system',
            io: ioInstance,
          });

          if (['card', 'payflex'].includes(order.payment_method) && order.payment_status === 'paid') {
            await RefundService.refundOrderPayment(
              order.id,
              order.user_id,
              'no_driver_available_timeout'
            ).catch(e => console.warn(`[Cron] Refund failed for ${order.id}:`, e.message));
          }

          if (ioInstance) {
            ioInstance.to(`user:${order.user_id}`).emit('order_update', {
              orderId: order.id,
              status: 'cancelled',
              message: 'No drivers were available. Your order has been cancelled and a full refund has been initiated.',
            });
          }

          console.log(`[Cron] Auto-cancelled no-driver order ${order.id} and initiated refund`);
        } catch (orderErr) {
          console.warn(`[Cron] Failed to auto-cancel order ${order.id}:`, orderErr.message);
        }
      }
    } catch (e) {
      console.warn('[Cron] No-driver auto-cancel error:', e.message);
    }
  });

  // STORE-ACCEPTANCE TIMEOUT: Runs every 15 minutes, same cadence as the
  // no-driver auto-cancel cron directly above, for consistency (founder's
  // explicit instruction). WHY: a customer's money must not sit trapped
  // waiting on a store that never responds -- if an order has been awaiting
  // store accept/reject for more than 15 minutes, auto-cancel and refund it,
  // the same way an unmatched waiting_for_driver order already is above.
  // Reuses rejectPendingAcceptance (already handles the transaction, the
  // real order_cancellations record, and the refund call) rather than
  // duplicating that logic inline a third time -- cancelledByRole: 'system'
  // so this is recorded as a real timeout, not misattributed as a store
  // rejection nobody actually made.
  cron.schedule('*/15 * * * *', async () => {
    try {
      const stuckAcceptanceOrders = await pool.query(`
        SELECT id
        FROM orders
        WHERE status = 'pending_store_acceptance'
          AND updated_at < NOW() - INTERVAL '15 minutes'
      `);

      for (const order of stuckAcceptanceOrders.rows) {
        try {
          const { rejectPendingAcceptance } = require('./services/orderStateMachineService');
          await rejectPendingAcceptance(order.id, {
            actorId: null,
            actorRole: 'system',
            cancelledByRole: 'system',
            reason: 'store_acceptance_timeout',
            io: _io,
          });
          console.log(`[Cron] Auto-cancelled unaccepted order ${order.id} after store-acceptance timeout`);
        } catch (orderErr) {
          console.warn(`[Cron] Failed to auto-cancel unaccepted order ${order.id}:`, orderErr.message);
        }
      }
    } catch (e) {
      console.warn('[Cron] Store-acceptance timeout error:', e.message);
    }
  });

  // WHY: users.flagged_for_cash_abuse/cash_refusal_count are real columns
  // already written to by paymentController.js (a customer flagged after
  // their second cash-payment refusal), but users can't be registered as a
  // real AdminJS resource (adapter introspection drops it -- schema
  // collision with Supabase's auth.users, see migrate.js v20's comment).
  // This keeps flagged_accounts -- a small, real, uniquely-named table the
  // admin panel CAN register -- in sync with the real, current flag state on
  // users, so admin-panel data is never more than ~15 minutes stale. Only
  // syncs the flag columns themselves; name/contact info is looked up live
  // elsewhere (adminPanel.js's attachUserNames), never duplicated here.
  cron.schedule('*/15 * * * *', async () => {
    try {
      await pool.query(`
        INSERT INTO flagged_accounts (user_id, flagged_for_cash_abuse, cash_refusal_count, synced_at)
        SELECT id, flagged_for_cash_abuse, COALESCE(cash_refusal_count, 0), NOW()
        FROM users
        WHERE flagged_for_cash_abuse = true OR COALESCE(cash_refusal_count, 0) > 0
        ON CONFLICT (user_id) DO UPDATE SET
          flagged_for_cash_abuse = EXCLUDED.flagged_for_cash_abuse,
          cash_refusal_count = EXCLUDED.cash_refusal_count,
          synced_at = NOW()
      `);
      await pool.query(`
        DELETE FROM flagged_accounts
        WHERE user_id NOT IN (
          SELECT id FROM users WHERE flagged_for_cash_abuse = true OR COALESCE(cash_refusal_count, 0) > 0
        )
      `);
    } catch (e) {
      console.warn('[Cron] Flagged-accounts sync error:', e.message);
    }
  });

  // WHY: Addendum 1 §4.4 named this explicitly -- accuracy can't be assumed
  // forever, only checked. Daily 04:00 SAST (a clean slot -- doesn't
  // collide with the 03:00/03:30/01:30 UTC jobs above). Two real checks:
  //
  // 1. wallet_balance reconciliation, for EVERY driver with a wallet row,
  //    not a sample. Confirmed the real accounting rule by reading
  //    DriverWallet.js directly rather than assuming: wallet_balance is
  //    only ever moved by 'available_credit' (adds, via releasePending/
  //    creditAvailable) and 'payout_debit' (subtracts, via
  //    createPayoutRequest/payoutService.finalizeSuccessfulPayout) ledger
  //    entries -- 'pending_credit'/'pending_debit' only ever touch the
  //    separate pending_balance column, never wallet_balance, so they're
  //    deliberately excluded from this formula rather than included by
  //    mistake. 'payout_debit_reconcile_required' (payoutService.js's own
  //    real, named edge case for when a wallet_balance guard blocked the
  //    normal deduction) is also deliberately excluded -- it exists
  //    specifically to flag that no deduction happened, so subtracting it
  //    here would manufacture a false mismatch, not report a real one.
  //
  // 2. A spot-check (this one genuinely sampled, per Addendum 1 §4.4's own
  //    wording, unlike the wallet check above) of recently-completed
  //    refunds against Paystack's own record via paystackService.fetchRefund
  //    -- the exact same method paymentReconciliationJob.js's existing
  //    reconcileStuckRefunds() already uses for 'processing' refunds, reused
  //    here for a different purpose: confirming already-'completed' rows
  //    are still actually correct, not trusting the local status alone.
  //
  // On any mismatch: log loudly AND Sentry.captureException -- the real,
  // already-proven-in-this-codebase Sentry mechanism (server.js's own
  // unhandledRejection handler and errorHandler.js both already use
  // exactly this, confirmed by reading them directly; it safely no-ops
  // with no SENTRY_DSN/non-prod, same as everywhere else it's used).
  cron.schedule('0 2 * * *', async () => {
    try {
      const wallets = await pool.query(`
        SELECT dw.driver_id, dw.wallet_balance,
               COALESCE(SUM(CASE WHEN dwl.entry_type = 'available_credit' THEN dwl.amount ELSE 0 END), 0) AS total_credits,
               COALESCE(SUM(CASE WHEN dwl.entry_type = 'payout_debit' THEN dwl.amount ELSE 0 END), 0) AS total_payout_debits
        FROM driver_wallets dw
        LEFT JOIN driver_wallet_ledger dwl ON dwl.driver_id = dw.driver_id
        GROUP BY dw.driver_id, dw.wallet_balance
      `);

      for (const row of wallets.rows) {
        const expected = parseFloat(row.total_credits) - parseFloat(row.total_payout_debits);
        const actual = parseFloat(row.wallet_balance);
        // 1 cent tolerance for floating-point/rounding noise, not a real
        // discrepancy allowance.
        if (Math.abs(expected - actual) > 0.01) {
          const mismatchErr = new Error(
            `[Reconciliation] Wallet balance mismatch for driver ${row.driver_id}: ` +
            `wallet_balance=${actual.toFixed(2)}, expected from ledger=${expected.toFixed(2)} ` +
            `(credits=${parseFloat(row.total_credits).toFixed(2)}, payout_debits=${parseFloat(row.total_payout_debits).toFixed(2)})`,
          );
          console.error(mismatchErr.message);
          Sentry.captureException(mismatchErr);
        }
      }
    } catch (e) {
      console.warn('[Cron] Wallet reconciliation error:', e.message);
    }

    try {
      const paystackService = require('./services/paystackService');
      const refunds = await pool.query(`
        SELECT id, refund_reference FROM payment_refunds
        WHERE status = 'completed' AND refund_reference IS NOT NULL
        ORDER BY updated_at DESC LIMIT 20
      `);

      for (const refund of refunds.rows) {
        try {
          const fetched = await paystackService.fetchRefund(refund.refund_reference);
          const realStatus = fetched?.data?.status;
          if (realStatus && realStatus !== 'processed') {
            const mismatchErr = new Error(
              `[Reconciliation] payment_refunds row ${refund.id} is marked 'completed' locally, ` +
              `but Paystack reports its real status as '${realStatus}' for refund_reference=${refund.refund_reference}`,
            );
            console.error(mismatchErr.message);
            Sentry.captureException(mismatchErr);
          }
        } catch (fetchErr) {
          console.warn(`[Cron] Reconciliation refund spot-check failed for refund ${refund.id}:`, fetchErr.message);
        }
      }
    } catch (e) {
      console.warn('[Cron] Refund reconciliation error:', e.message);
    }
  });

  return { app, server, io };
}

// Start server
function startServer() {
  const { app, server, io } = createApp();
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`\n Flash Backend v3.0 (MVC) on port ${PORT}`);
    console.log(` Cleanup cron scheduled (daily 3am)`);
    console.log(` Socket.IO ready for real-time events`);
    console.log(`Server is running!\n`);
  });

  // Fire-and-forget, mounted onto the already-running app — Express allows
  // routes to be added after listen() starts, so this never blocks or delays
  // server startup. Deliberately not awaited here: createApp()/startServer()
  // both stay synchronous (tests and mock-server depend on createApp()'s
  // existing contract), and a failure here must never crash the real server —
  // same "log loudly, don't take the process down" standard as the cron jobs.
  const { mountAdminPanel } = require("./adminPanel");
  mountAdminPanel(app).catch((err) => {
    console.error("[AdminPanel] Failed to mount:", err.message);
  });

  return { app, server, io };
}

const runtime = require.main === module ? startServer() : createApp();

// Graceful shutdown
async function gracefulShutdown(signal) {
  console.log(`\n[${signal}] Starting graceful shutdown...`);
  runtime.server.close(async () => {
    try {
      await pool.end();
      console.log("[Shutdown] DB pool closed. Goodbye.");
    } catch (e) {
      console.warn("[Shutdown] pool.end error:", e.message);
    }
    process.exit(0);
  });
  setTimeout(() => {
    console.error("[Shutdown] Timeout — forcing exit");
    process.exit(1);
  }, 10000);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
  // Previously only console.error'd — every unhandled rejection in
  // production was invisible to Sentry, the same blind spot Sentry was
  // added to close for synchronous/request-path errors. Sentry.captureException
  // safely no-ops if Sentry.init() was never called (no SENTRY_DSN/non-prod).
  logger.error({ err: reason }, "Unhandled promise rejection");
  Sentry.captureException(reason instanceof Error ? reason : new Error(String(reason)));
});

module.exports = {
  createApp,
  startServer,
  app: runtime.app,
  server: runtime.server,
  io: runtime.io,
};