const pool = require("../config/database");

// NOTE: this used to have its own DRIVER_TEST_MODE bypass here too, which
// exempted *every* driver from the subscription check for as long as the
// flag was on — not just accounts created during the test window. Moved
// to Driver.create(): DRIVER_TEST_MODE now grants a real, signup-scoped
// driver_subscriptions row instead, so this function's real, unmodified
// check passes naturally for test accounts without a second bypass here.
// Keeps the whole mechanism genuinely "signup only," matching the
// document-approval half of the same flag.

async function checkDriverSubscriptionAllowed(driverId) {
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
