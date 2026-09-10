/**
 * flash-driver-app/services/analytics.js
 *
 * PostHog wrapper — deliberately narrow, mirrors flash-user-app/services/
 * analytics.js exactly. Only the named functions below ever call
 * posthog.capture()/identify(); there is no generic track(eventName, props)
 * escape hatch, so every event Flash sends is visible by reading this one
 * file, matching the taxonomy in docs/audits/POSTHOG_ANALYTICS_DESIGN.md §2.
 *
 * No autocapture, no session replay (design doc §3) — see the matching
 * comment in flash-user-app/services/analytics.js for why direct
 * instantiation (never <PostHogProvider>) already guarantees this.
 *
 * EXPO_PUBLIC_POSTHOG_API_KEY has no real value yet — same pattern as
 * EXPO_PUBLIC_SENTRY_DSN before Sentry was fully configured. Every function
 * below no-ops safely until Vuyo creates the PostHog account and provides
 * a real key.
 */

import PostHog from 'posthog-react-native';

let client = null;

if (process.env.EXPO_PUBLIC_POSTHOG_API_KEY) {
  try {
    client = new PostHog(process.env.EXPO_PUBLIC_POSTHOG_API_KEY, {
      host: process.env.EXPO_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com',
      captureAppLifecycleEvents: false,
      enableSessionReplay: false,
    });
  } catch (_) {
    client = null;
  }
}

// ── Identity ─────────────────────────────────────────────────────────────
// distinct_id is always the real drivers.id already in Postgres.
function identify(driverId) {
  if (!client || !driverId) return;
  try { client.identify(String(driverId)); } catch (_) {}
}

// ── Auth ─────────────────────────────────────────────────────────────────
// Only driver_signed_up is in the design doc's taxonomy — unlike the user
// app, there's no matching "driver_logged_in" event defined, so an existing
// driver's login (password or OAuth) intentionally sends nothing here. Not
// an oversight in this file — implementing exactly the approved table, not
// expanding it, per the explicit "nothing more than the taxonomy" scope.
function driverSignedUp(signupMethod) {
  if (!client) return;
  try { client.capture('driver_signed_up', { signup_method: signupMethod }); } catch (_) {}
}

function driverApproved() {
  if (!client) return;
  try { client.capture('driver_approved'); } catch (_) {}
}

// ── Availability ─────────────────────────────────────────────────────────
function driverOnlineToggled(state) {
  if (!client) return;
  try { client.capture('driver_online_toggled', { state }); } catch (_) {}
}

// ── Navigation ───────────────────────────────────────────────────────────
function screenViewed(screenName) {
  if (!client) return;
  try { client.capture('screen_viewed', { screen_name: screenName }); } catch (_) {}
}

// ── Orders ───────────────────────────────────────────────────────────────
function orderAccepted(orderId) {
  if (!client) return;
  try { client.capture('order_accepted', { order_id: orderId }); } catch (_) {}
}

// No decline/reject action exists anywhere in the driver app today (a
// driver either accepts a match or lets it time out) — this function
// exists to match the design doc's taxonomy and stays ready for a future
// real decline button, but nothing currently calls it. Flagged here rather
// than silently wired to something that doesn't exist.
function orderRejected(orderId) {
  if (!client) return;
  try { client.capture('order_rejected', { order_id: orderId }); } catch (_) {}
}

function pickupConfirmed(orderId) {
  if (!client) return;
  try { client.capture('pickup_confirmed', { order_id: orderId }); } catch (_) {}
}

function dropoffConfirmed(orderId) {
  if (!client) return;
  try { client.capture('dropoff_confirmed', { order_id: orderId }); } catch (_) {}
}

// earnings not populated — activeOrder doesn't currently expose a
// driver-earnings field at this call site (dashboard.js's handleStatusUpdate),
// and fetching one purely for analytics is out of scope for this pass, same
// reasoning as order_completed's order_value gap in the user app.
function orderCompletedByDriver(orderId) {
  if (!client) return;
  try { client.capture('order_completed_by_driver', { order_id: orderId }); } catch (_) {}
}

const analytics = {
  identify,
  driverSignedUp,
  driverApproved,
  driverOnlineToggled,
  screenViewed,
  orderAccepted,
  orderRejected,
  pickupConfirmed,
  dropoffConfirmed,
  orderCompletedByDriver,
};

export default analytics;
