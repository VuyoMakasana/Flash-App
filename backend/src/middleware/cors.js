const cors = require("cors");
const { isProd, isDev } = require("../config/env");

// Configure CORS for production and development
const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps, curl, Postman, etc.)
    if (!origin) return callback(null, true);

    let allowedOrigins = [];

    // Get ALLOWED_ORIGINS from environment
    if (process.env.ALLOWED_ORIGINS) {
      allowedOrigins = process.env.ALLOWED_ORIGINS.split(",").map((o) =>
        o.trim(),
      );
    } else if (isDev) {
      // Development defaults - permissive for easier local testing
      allowedOrigins = [
        "http://localhost:3000",
        "http://localhost:3001",
        "http://localhost:8081", // React Native dev
        "http://localhost:19002", // Expo
        "http://127.0.0.1:3000",
        "http://127.0.0.1:3001",
        "http://127.0.0.1:8081",
        "http://127.0.0.1:19002",
      ];
      console.log("[CORS] ℹ️  Using development defaults. Set ALLOWED_ORIGINS to control.");
    } else {
      // Production: no defaults - must be explicitly configured
      console.warn(
        "[CORS] ⚠️  ALLOWED_ORIGINS not configured. CORS will block all requests.",
      );
    }

    // Check origin
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else if (!isProd) {
      // In development, be more forgiving
      console.warn(`[CORS] Request from unauthorized origin: ${origin}`);
      callback(null, true); // Still allow, but log it
    } else {
      // Production: strict rejection
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true,
  optionsSuccessStatus: 200,
  methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

const corsMiddleware = cors(corsOptions);

module.exports = { corsMiddleware };
