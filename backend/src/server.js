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

// 404 and error handlers
  app.use(notFound);
  app.use(errorHandler);

// Setup Socket.IO
  setupSocket(io);

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

  return { app, server, io };
}

// Start server
function startServer() {
  const { app, server, io } = createApp();
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`\n✨ Flash Backend v3.0 (MVC) on port ${PORT}`);
    console.log(`🧹 Cleanup cron scheduled (daily 3am)`);
    console.log(`📡 Socket.IO ready for real-time events`);
    console.log(`🚀 Server is running!\n`);
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
