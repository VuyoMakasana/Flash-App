const pool = require("../config/database");

// TEMPORARY TEST-MODE BYPASS — remove before real launch.
// When DRIVER_TEST_MODE=true on Render, every driver skips the real
// subscription requirement entirely. This exists only to let real testers
// place orders during this testing period without buying a plan. Set
// DRIVER_TEST_MODE back to unset/false (or delete it) before going live —
// this function is the single point every subscription check in the app
// routes through, so this one flag controls all of them.
const TEST_MODE = process.env.DRIVER_TEST_MODE === "true";

async function checkDriverSubscriptionAllowed(driverId) {
  if (TEST_MODE) {
    return { allowed: true, subscription: null };
  }

  const result = await pool.query(
    `SELECT * FROM driver_subscriptions WHERE driver_id=$1 AND status='active' AND expires_at>NOW() ORDER BY created_at DESC LIMIT 1`,
    [driverId],
  );
  const sub = result.rows[0];
  if (!sub) {
    return {
      allowed: false,
      reason: 
        "No active subscription plan. Purchase a plan to accept deliveries.",
    };
  }
  if (
    sub.deliveries_limit !== null &&
    sub.deliveries_used >= sub.deliveries_limit
  ) {
    return {
      allowed: false,
      reason: `Delivery limit reached for your ${sub.plan_type} plan.`,
    };
  }
  return { allowed: true, subscription: sub };
}

module.exports = { checkDriverSubscriptionAllowed };
