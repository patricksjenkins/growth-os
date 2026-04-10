/**
 * WellMor Push Notification Agent
 * Handles device registration and sending Expo push notifications.
 *
 * Expo Push API: https://docs.expo.dev/push-notifications/sending-notifications/
 */

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { createLogger } = require('./shared/logger');
const { supabase } = require('./shared/supabase');

const logger = createLogger('PushNotifications');
const router = express.Router();

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

/**
 * POST /agents/notifications/register-device
 * Register a device push token
 */
router.post('/register-device', async (req, res) => {
  try {
    const { token, platform, device_name } = req.body || {};

    if (!token) {
      return res.status(400).json({ success: false, error: 'token is required' });
    }

    // Upsert device token
    const { error } = await supabase
      .from('push_devices')
      .upsert([{
        token,
        platform: platform || 'ios',
        device_name: device_name || 'Unknown',
        active: true,
        updated_at: new Date().toISOString()
      }], { onConflict: 'token' });

    if (error) {
      // Table may not exist — just log
      logger.warn('Could not save push token (table may not exist)', { token: token.slice(0, 20) });
    } else {
      logger.success(`Registered push device: ${device_name || 'Unknown'}`);
    }

    res.json({ success: true });
  } catch (err) {
    logger.error('Device registration failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Send a push notification to all registered devices
 */
async function sendPushNotification({ title, body, data = {} }) {
  try {
    // Fetch all active device tokens
    const { data: devices, error } = await supabase
      .from('push_devices')
      .select('token')
      .eq('active', true);

    if (error || !devices || devices.length === 0) {
      logger.info('No push devices registered');
      return { sent: 0 };
    }

    const messages = devices.map(device => ({
      to: device.token,
      sound: 'default',
      title,
      body,
      data,
      badge: 1,
    }));

    // Send in batches of 100 (Expo limit)
    const results = [];
    for (let i = 0; i < messages.length; i += 100) {
      const batch = messages.slice(i, i + 100);
      const response = await axios.post(EXPO_PUSH_URL, batch, {
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip, deflate',
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      });
      results.push(...(response.data?.data || []));
    }

    const sent = results.filter(r => r.status === 'ok').length;
    const failed = results.filter(r => r.status === 'error').length;

    logger.success(`Push sent: ${sent} ok, ${failed} failed`);

    // Deactivate invalid tokens
    for (const result of results) {
      if (result.status === 'error' && result.details?.error === 'DeviceNotRegistered') {
        const badToken = messages[results.indexOf(result)]?.to;
        if (badToken) {
          await supabase
            .from('push_devices')
            .update({ active: false })
            .eq('token', badToken);
        }
      }
    }

    return { sent, failed };
  } catch (err) {
    logger.error('Push notification failed', err);
    return { sent: 0, error: err.message };
  }
}

/**
 * POST /agents/notifications/send
 * Send a push notification (internal use / testing)
 */
router.post('/send', async (req, res) => {
  try {
    const { title, body, data } = req.body || {};

    if (!title || !body) {
      return res.status(400).json({ success: false, error: 'title and body are required' });
    }

    const result = await sendPushNotification({ title, body, data });

    res.json({ success: true, ...result });
  } catch (err) {
    logger.error('Send push failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /agents/notifications/devices
 * List registered devices
 */
router.get('/devices', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('push_devices')
      .select('token, platform, device_name, active, updated_at')
      .order('updated_at', { ascending: false });

    if (error) {
      return res.json({ success: true, devices: [], note: 'push_devices table may not exist' });
    }

    res.json({ success: true, devices: data || [] });
  } catch (err) {
    logger.error('List devices failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /agents/notifications/pending
 * List pending notifications from the notifications table
 */
router.get('/pending', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('notifications')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      return res.json({ success: true, notifications: [] });
    }

    res.json({ success: true, notifications: data || [] });
  } catch (err) {
    logger.error('Pending notifications failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
module.exports.sendPushNotification = sendPushNotification;
