/**
 * flash-user-app/services/analytics.js
 *
 * PostHog wrapper — deliberately narrow. Only the named functions below
 * ever call posthog.capture()/identify(); there is no generic
 * track(eventName, props) escape hatch, so every event Flash sends is
 * visible by reading this one file, matching the taxonomy in
 * docs/audits/POSTHOG_ANALYTICS_DESIGN.md §2 exactly.
 *
 * No autocapture, no session replay (design doc §3) — captureAppLifecycleEvents
 * and enableSessionReplay are both explicitly set to false below, and the
 * SDK is used via direct instantiation (new PostHog(...)), never
 * <PostHogProvider>, which is what would wire up automatic screen/touch
 * capture in the first place. A bare instantiated client has no autocapture
 * mechanism at all, confirmed directly against the installed package's own
 * type definitions (node_modules/posthog-react-native/dist/posthog-rn.d.ts) —
 * this isn't "capture is off," it's "the thing that would capture doesn't exist."
 *
 * EXPO_PUBLIC_POSTHOG_API_KEY carries a real project key as of 2026-09-10
 * (set in .env locally and as a plaintext EAS env var for both the
 * production and preview build profiles — not "secret" visibility, since
 * EAS itself rejects that for an EXPO_PUBLIC_-prefixed variable: it's
 * compiled into the client bundle regardless, so "secret" would be
 * misleading, not protective. A write-only project token, same posture as
 * EXPO_PUBLIC_SENTRY_DSN). Real events now flow — verified end-to-end
 * (docs/audits/POSTHOG_ANALYTICS_DESIGN.md §7). The client-null guard below
 * stays regardless: it's what makes a missing/blank key a safe no-op
 * rather than a crash, in any environment that doesn't have one set.
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
// distinct_id is always the real users.id already in Postgres — never an
// email or phone number — so behavior can be joined back to a real account
// without an event property ever carrying PII on its own.
function identify(userId) {
  if (!client || !userId) return;
  try { client.identify(String(userId)); } catch (_) {}
}

// ── Auth ─────────────────────────────────────────────────────────────────
function userSignedUp(signupMethod) {
  if (!client) return;
  try { client.capture('user_signed_up', { signup_method: signupMethod }); } catch (_) {}
}

function userLoggedIn(loginMethod) {
  if (!client) return;
  try { client.capture('user_logged_in', { login_method: loginMethod }); } catch (_) {}
}

// ── Navigation ───────────────────────────────────────────────────────────
// Only the 9 screens named in the design doc's taxonomy call this — every
// other screen in the app deliberately does not, so this list stays exact
// rather than growing ad hoc.
function screenViewed(screenName) {
  if (!client) return;
  try { client.capture('screen_viewed', { screen_name: screenName }); } catch (_) {}
}

// ── Checkout / orders ────────────────────────────────────────────────────
function paymentMethodSelected(method) {
  if (!client) return;
  try { client.capture('payment_method_selected', { method }); } catch (_) {}
}

function orderPlaced({ orderId, orderValue, itemCount, storeId, deliveryType }) {
  if (!client) return;
  try {
    client.capture('order_placed', {
      order_id: orderId,
      order_value: orderValue,
      item_count: itemCount,
      store_id: storeId,
      delivery_type: deliveryType,
    });
  } catch (_) {}
}

function orderCancelled(orderId, stageAtCancellation) {
  if (!client) return;
  try {
    client.capture('order_cancelled', {
      order_id: orderId,
      stage_at_cancellation: stageAtCancellation,
    });
  } catch (_) {}
}

// orderValue/timeToDeliverMinutes are best-effort: the live socket event
// this fires from (TrackingScreen.js) only carries { orderId, status }, not
// the full order record — populating either property here would mean a new
// network call made purely for analytics, out of scope for this pass. The
// one call site that happens to already have the full order object (the
// socket-fallback poll, same screen) does pass order_value through.
function orderCompleted({ orderId, orderValue, timeToDeliverMinutes }) {
  if (!client) return;
  try {
    client.capture('order_completed', {
      order_id: orderId,
      order_value: orderValue,
      time_to_deliver_minutes: timeToDeliverMinutes,
    });
  } catch (_) {}
}

const analytics = {
  identify,
  userSignedUp,
  userLoggedIn,
  screenViewed,
  paymentMethodSelected,
  orderPlaced,
  orderCancelled,
  orderCompleted,
};

export default analytics;
