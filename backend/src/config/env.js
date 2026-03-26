/**
 * Environment Configuration Validator
 *
 * Provides safe access to environment variables with proper validation.
 * - Production: Throws errors if required secrets are missing or invalid
 * - Development: Allows placeholders and safe fallbacks
 *
 * Usage:
 *   const config = require('./env');
 *   const jwtSecret = config.getRequired('JWT_SECRET', 'auth');
 *   const optional = config.getOptional('GOOGLE_MAPS_API_KEY');
 */

const isDev = process.env.NODE_ENV !== "production";
const isProd = process.env.NODE_ENV === "production";

/**
 * Get a required environment variable
 * - In production: Throws if missing or is placeholder
 * - In development: Allows placeholders, throws only if completely missing
 */
function getRequired(key, scope = "config") {
  const value = process.env[key];

  if (!value) {
    const msg = `[${scope}] CRITICAL: Missing required environment variable: ${key}`;
    if (isProd) {
      throw new Error(msg);
    }
    console.warn(`[${scope}] ⚠️  ${msg}`);
    return null;
  }

  // Check for placeholder values in production
  const placeholders = [
    "your_",
    "placeholder",
    "change_me",
    "xxx",
    "sk_test_",
    "pk_test_",
  ];
  const isPlaceholder = placeholders.some((p) =>
    value.toLowerCase().includes(p),
  );

  if (isPlaceholder && isProd) {
    const msg = `[${scope}] CRITICAL: ${key} appears to be a placeholder/test value in production`;
    throw new Error(msg);
  }

  if (isPlaceholder && isDev) {
    console.warn(
      `[${scope}] ⚠️  ${key} appears to be a placeholder. Update before production.`,
    );
  }

  return value;
}

/**
 * Get an optional environment variable
 * Returns null if not set, with optional validation
 */
function getOptional(key, scope = "config") {
  const value = process.env[key];
  if (!value) return null;

  // Warn about test/placeholder values even for optional vars
  const isTestValue =
    value.includes("sk_test_") ||
    value.includes("pk_test_") ||
    value.includes("your_");
  if (isTestValue && isDev) {
    console.warn(`[${scope}] ℹ️  ${key} is using a test/placeholder value`);
  }

  return value;
}

/**
 * Validate that a required value is not a placeholder
 * Useful for secrets that should never be placeholders after startup
 */
function validateNotPlaceholder(key, value, scope = "config") {
  const placeholders = [
    "your_",
    "placeholder",
    "change_me",
    "xxx",
    "sk_test_",
    "pk_test_",
  ];
  const isPlaceholder = placeholders.some((p) =>
    String(value || "").toLowerCase().includes(p),
  );

  if (isPlaceholder && isProd) {
    throw new Error(
      `[${scope}] CRITICAL: ${key} cannot use placeholder values in production`,
    );
  }

  return !isPlaceholder;
}

/**
 * Validate database URL format (basic check)
 */
function validateDatabaseURL(url, scope = "database") {
  if (!url) {
    if (isProd) throw new Error(`[${scope}] DATABASE_URL is required in production`);
    console.warn(`[${scope}] ⚠️  DATABASE_URL not set`);
    return false;
  }

  if (url.includes("placeholder") || url === "your_database_url") {
    if (isProd) throw new Error(`[${scope}] DATABASE_URL cannot be placeholder in production`);
    console.warn(`[${scope}] ⚠️  DATABASE_URL is a placeholder`);
    return false;
  }

  return true;
}

module.exports = {
  isDev,
  isProd,
  getRequired,
  getOptional,
  validateNotPlaceholder,
  validateDatabaseURL,
};
