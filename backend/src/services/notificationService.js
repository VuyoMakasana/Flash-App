const https = require("https");
const db = require("../config/database");

// Expo push notification endpoint
const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

// Send a push notification via Expo's push service.
// tokens can be a single string or an array of strings.
async function sendPushNotification({ tokens, title, body, data = {} }) {
  const tokenArray = Array.isArray(tokens) ? tokens : [tokens];

  // Filter out null/undefined/empty tokens before sending
  const validTokens = tokenArray.filter(
    (t) => typeof t === "string" && t.startsWith("ExponentPushToken["),
  );

  if (!validTokens.length) return;

  const messages = validTokens.map((to) => ({
    to,
    title,
    body,
    data,
    sound: "default",
    priority: "high",
  }));

  const payload = JSON.stringify(messages);

  return new Promise((resolve, reject) => {
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
          resolve(JSON.parse(responseData));
        } catch (_) {
          resolve({ raw: responseData });
        }
      });
    });

    req.on("error", (err) => {
      // Log but don't crash the order flow — push notifications are best-effort.
      console.error("[PushNotification] Request error:", err.message);
      resolve(null);
    });

    req.write(payload);
    req.end();
  });
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

    await sendPushNotification({
      tokens,
      title: isCashDelivery ? "New Cash Order Available!" : "New Order Available!",
      body: hasUnexpiredPreference
        ? "A customer has requested you for a delivery. Tap to view and accept."
        : "Tap to view and accept the delivery.",
      data: { orderId, type: "new_order" },
    });
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
      driver_assigned:      "Your driver has been assigned!",
      driver_arrived_store: "Your driver is at the store.",
      picked_up:            "Your order has been picked up.",
      in_transit:           "Your order is on the way to you!",
      delivered:            "Your order has been delivered.",
      completed:            "Delivery complete. Thanks for using Flash!",
      cancelled:            "Your order has been cancelled.",
    };

    const body = statusMessages[status] || `Order status updated: ${status}`;

    await sendPushNotification({
      tokens: [result.rows[0].push_token],
      title: "Flash Order Update",
      body,
      data: { orderId, status, type: "order_update" },
    });
  } catch (err) {
    console.error("[PushNotification] notifyUserOrderUpdate error:", err.message);
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
  notifyDriversNewOrder,
  notifyUserOrderUpdate,
  saveUserPushToken,
  saveDriverPushToken,
};