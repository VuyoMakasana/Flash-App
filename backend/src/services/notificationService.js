const https = require("https");
const Sentry = require("@sentry/node");
const db = require("../config/database");

// Expo push notification endpoint
const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

// Send a push notification via Expo's push service.
// tokens can be a single string or an array of strings.
//
// Returns { sent: false, reason, error } on a transport-level failure, or
// { sent: true, response } on a completed HTTP round-trip -- `response` may
// still contain Expo's own per-ticket errors (e.g. an expired/uninstalled
// token), which sendPushNotification itself doesn't inspect since it has no
// idea which order/user this notification was even for; see
// reportPushFailure below, called by each real caller with its own context.
async function sendPushNotification({ tokens, title, body, data = {} }) {
  const tokenArray = Array.isArray(tokens) ? tokens : [tokens];

  // Filter out null/undefined/empty tokens before sending
  const validTokens = tokenArray.filter(
    (t) => typeof t === "string" && t.startsWith("ExponentPushToken["),
  );

  if (!validTokens.length) return { sent: false, reason: "no_valid_tokens" };

  const messages = validTokens.map((to) => ({
    to,
    title,
    body,
    data,
    sound: "default",
    priority: "high",
  }));

  const payload = JSON.stringify(messages);

  return new Promise((resolve) => {
    const options = {
      hostname: "exp.host",
      path: "/--/api/v2/push/send",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "Accept-Encoding": "gzip, deflate",
        "Content-Length": Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, (res) => {
      let responseData = "";
      res.on("data", (chunk) => { responseData += chunk; });
      res.on("end", () => {
        try {
          resolve({ sent: true, response: JSON.parse(responseData) });
        } catch (_) {
          resolve({ sent: true, response: { raw: responseData } });
        }
      });
    });

    req.on("error", (err) => {
      // Log but don't crash the order flow — push notifications are best-effort.
      console.error("[PushNotification] Request error:", err.message);
      resolve({ sent: false, reason: "transport_error", error: err.message });
    });

    req.write(payload);
    req.end();
  });
}

// §2.6 audit — a failed push was previously either console.error'd (the
// transport case) or entirely unexamined (Expo's own per-ticket errors,
// e.g. DeviceNotRegistered for an expired/uninstalled-app token, were never
// even looked at) — either way, invisible in Sentry, indistinguishable from
// "delivered successfully." Deliberately NOT a retry queue or dead-letter
// table (real new infrastructure for a failure mode that never loses real
// order/message data, just a notification) -- just makes an already-silent
// failure visible and actionable with real context, using Sentry, which is
// already wired up.
function reportPushFailure(result, context) {
  if (!result) return;

  if (!result.sent) {
    if (result.reason === "no_valid_tokens") return; // not a failure -- there was simply nothing to send to
    Sentry.captureException(new Error(`Push notification transport failure: ${result.reason}`), {
      extra: { ...context, error: result.error },
    });
    return;
  }

  const tickets = Array.isArray(result.response?.data) ? result.response.data : [];
  const errors = tickets.filter((t) => t?.status === "error");
  if (errors.length) {
    Sentry.captureException(new Error("Push notification ticket error(s) from Expo"), {
      extra: { ...context, errors },
    });
  }
}

async function notifyDriversNewOrder(
  orderId,
  isCashDelivery = false,
  preferredDriverId = null,
  preferredDriverExpiresAt = null,
) {
  try {
    const hasUnexpiredPreference =
      preferredDriverId &&
      preferredDriverExpiresAt &&
      new Date(preferredDriverExpiresAt).getTime() > Date.now();

    let result;
    if (hasUnexpiredPreference) {
      result = await db.query(
        `SELECT push_token FROM drivers
         WHERE id = $1
           AND status = 'approved'
           AND push_token IS NOT NULL`,
        [preferredDriverId],
      );
    } else {
      result = await db.query(
        `SELECT push_token FROM drivers
         WHERE is_online = true
           AND status = 'approved'
           AND push_token IS NOT NULL`,
      );
    }

    const tokens = result.rows.map((r) => r.push_token);
    if (!tokens.length) return;

    const pushResult = await sendPushNotification({
      tokens,
      title: isCashDelivery ? "New Cash Order Available!" : "New Order Available!",
      body: hasUnexpiredPreference
        ? "A customer has requested you for a delivery. Tap to view and accept."
        : "Tap to view and accept the delivery.",
      data: { orderId, type: "new_order" },
    });
    reportPushFailure(pushResult, { orderId, notificationType: "new_order", recipientCount: tokens.length });
  } catch (err) {
    console.error("[PushNotification] notifyDriversNewOrder error:", err.message);
  }
}

// Notify a specific user about their order status update.
async function notifyUserOrderUpdate(userId, orderId, status) {
  try {
    const result = await db.query(
      `SELECT push_token FROM users WHERE id = $1 AND push_token IS NOT NULL`,
      [userId],
    );
    if (!result.rows.length) return;

    const statusMessages = {
      // Store accept/reject/preparing gate (docs/audits/FLASH_STORE_ADMIN_DESIGN.md
      // §0) -- none of these three existed as real, specific messages
      // before (pending_store_acceptance/preparing are brand new;
      // waiting_for_driver previously fell through to the generic
      // fallback below, same as these two would without an entry here).
      pending_store_acceptance: "We've received your order — the store is reviewing it now.",
      preparing:                "Your order is being prepared!",
      waiting_for_driver:       "Your order is ready — looking for a nearby driver.",
      driver_assigned:      "Your driver has been assigned!",
      driver_arrived_store: "Your driver is at the store.",
      picked_up:            "Your order has been picked up.",
      in_transit:           "Your order is on the way to you!",
      delivered:            "Your order has been delivered.",
      completed:            "Delivery complete. Thanks for using Flash!",
      cancelled:            "Your order has been cancelled.",
    };

    const body = statusMessages[status] || `Order status updated: ${status}`;

    const pushResult = await sendPushNotification({
      tokens: [result.rows[0].push_token],
      title: "Flash Order Update",
      body,
      data: { orderId, status, type: "order_update" },
    });
    reportPushFailure(pushResult, { orderId, userId, status, notificationType: "order_update" });
  } catch (err) {
    console.error("[PushNotification] notifyUserOrderUpdate error:", err.message);
  }
}

// Notify the other party in an order chat about a new message. Best-effort
// like every helper above -- a slow/failed push must never block the
// message itself, which is already saved to the DB and emitted over the
// socket by the time this runs.
async function notifyNewMessage(recipientId, recipientRole, orderId, senderRole, content) {
  try {
    const result = recipientRole === "driver"
      ? await db.query(`SELECT push_token FROM drivers WHERE id = $1 AND push_token IS NOT NULL`, [recipientId])
      : await db.query(`SELECT push_token FROM users WHERE id = $1 AND push_token IS NOT NULL`, [recipientId]);
    if (!result.rows.length) return;

    const senderLabel = senderRole === "driver" ? "driver" : "customer";
    const preview = content.length > 100 ? `${content.slice(0, 100)}…` : content;

    const pushResult = await sendPushNotification({
      tokens: [result.rows[0].push_token],
      title: `New message from your ${senderLabel}`,
      body: preview,
      data: { orderId, type: "new_message" },
    });
    reportPushFailure(pushResult, { orderId, recipientId, recipientRole, notificationType: "new_message" });
  } catch (err) {
    console.error("[PushNotification] notifyNewMessage error:", err.message);
  }
}

// Save or update the push token for a user.
async function saveUserPushToken(userId, pushToken) {
  await db.query(
    `UPDATE users SET push_token = $1, updated_at = NOW() WHERE id = $2`,
    [pushToken, userId],
  );
}

// Save or update the push token for a driver.
async function saveDriverPushToken(driverId, pushToken) {
  await db.query(
    `UPDATE drivers SET push_token = $1, updated_at = NOW() WHERE id = $2`,
    [pushToken, driverId],
  );
}

module.exports = {
  sendPushNotification,
  reportPushFailure,
  notifyDriversNewOrder,
  notifyUserOrderUpdate,
  notifyNewMessage,
  saveUserPushToken,
  saveDriverPushToken,
};