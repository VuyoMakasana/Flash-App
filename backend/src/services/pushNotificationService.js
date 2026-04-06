// FIX 6: New push notification service — drivers missed orders when the app was backgrounded because the system relied solely on sockets which disconnect in the background
const { Expo } = require('expo-server-sdk');
const expo = new Expo();

async function sendDriverPushNotification(pushToken, title, body, data = {}) {
  if (!pushToken || !Expo.isExpoPushToken(pushToken)) return;
  try {
    await expo.sendPushNotificationsAsync([{
      to: pushToken,
      sound: 'default',
      title,
      body,
      data,
    }]);
  } catch (e) {
    console.warn('[Push] Failed to send notification:', e.message);
  }
}

module.exports = { sendDriverPushNotification };
