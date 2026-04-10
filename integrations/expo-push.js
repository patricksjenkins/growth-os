/**
 * Growth OS — Expo Push Notifications
 */

const axios = require('axios');
const { createLogger } = require('../core/logger');
const log = createLogger('expo-push');

/**
 * Send push notification via Expo
 */
async function sendPushNotification(pushToken, title, body, data = {}) {
  if (!pushToken) return null;

  try {
    const response = await axios.post('https://exp.host/--/api/v2/push/send', {
      to: pushToken,
      title,
      body,
      data,
      sound: 'default'
    });
    log.success(`Push sent: ${title}`);
    return response.data;
  } catch (error) {
    log.error('Push failed', error);
    return null;
  }
}

module.exports = { sendPushNotification };
