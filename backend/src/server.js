// src/server.js
require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const helmet = require("helmet");
const morgan = require("morgan");
const cron = require("node-cron");
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
const { errorHandler, notFound } = require("./middleware/errorHandler");
const {
  limiter,
  authLimiter,
  orderLimiter,
} = require("./middleware/rateLimiter");
const { corsMiddleware } = require("./middleware/cors");
const setupSocket = require("./socket/socketServer");
const { reconcilePendingPayments } = require("./services/paymentReconciliationJob");

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

function createApp() {
  const app = express();
  // Trust reverse proxy headers in production deployments (Render/Railway/Nginx).
  if (process.env.NODE_ENV === "production") {
    app.set("trust proxy", 1);
  }

  const server = http.createServer(app);
  const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    maxHttpBufferSize: 1e6,
    perMessageDeflate: false,
    pingTimeout: 60000,
    pingInterval: 25000,
  });

  app.set("io", io);

// Security middleware
  app.use(helmet());
  app.use(corsMiddleware);

// Webhook routes: each route applies its own body parser (raw for Paystack,
// JSON for Payflex) so we mount the router directly without global raw parsing.
  app.use("/api/webhooks", webhookRoutes);

// Body parsing
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true }));

// Logging
  if (process.env.NODE_ENV !== "test") {
    app.use(morgan(process.env.NODE_ENV === "production" ? "tiny" : "combined"));
  }

// Rate limiting
  app.use("/api/", limiter);
  app.use("/api/auth/", authLimiter);
  app.use("/api/orders/", orderLimiter); // Stricter limits for order creation

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

// Health check
  app.get("/health", (req, res) =>
    res.json({
      status: "ok",
      version: "3.0.0",
      timestamp: new Date().toISOString(),
    }),
  );

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
  });

  // OPERATING HOURS: Every day at 07:00 SAST (05:00 UTC), release all orders
  // that were placed overnight and are waiting in 'scheduled_for_morning'.
  // These are converted to 'waiting_for_driver' so drivers can start accepting them.
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
          await updateOrderStatus(order.id, 'waiting_for_driver', {
            actorId: 'system',
            actorRole: 'system',
            io: _io,
          });
          if (_io) {
            _io.to(`user:${order.user_id}`).emit('order_update', {
              orderId: order.id,
              status: 'waiting_for_driver',
              message: 'Good morning! Flash is now open. Your order is being assigned to a driver.',
            });
          }
          console.log(`[OperatingHours] Released scheduled order ${order.id} to driver pool`);
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
               d.push_token as driver_push_token
        FROM orders o
        LEFT JOIN drivers d ON d.id = o.driver_id
        WHERE o.status IN ('driver_assigned', 'driver_arrived_store')
          AND o.updated_at < NOW() - INTERVAL '45 minutes'
          AND o.driver_id IS NOT NULL
      `);

      for (const order of stuckOrders.rows) {
        try {
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

          // Re-queue the order for fleet or notify user
          await pool.query(
            `UPDATE orders SET driver_id = NULL, status = 'waiting_for_driver',
             delivery_payment_status = 'pending_driver', updated_at = NOW()
             WHERE id = $1`,
            [order.id]
          );

          // Notify user
          const ioInstance = _io;
          if (ioInstance) {
            ioInstance.to(`user:${order.user_id}`).emit('order_update', {
              orderId: order.id,
              status: 'waiting_for_driver',
              message: 'Your driver became unavailable. Finding a new driver now.',
            });
          }

          // Attempt auto-reassign for fleet orders
          if (order.delivery_mode === 'fleet') {
            const { autoAssignNearestDriver } = require('./services/fleetIntelligenceService');
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
  console.error("[UnhandledRejection]", reason);
});

module.exports = {
  createApp,
  startServer,
  app: runtime.app,
  server: runtime.server,
  io: runtime.io,
};