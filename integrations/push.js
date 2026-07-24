/**
 * Growth OS — Expo Push Notification Integration
 *
 * Tenant-aware sender for Expo push notifications. Any agent can call
 * sendPushToTenant(tenantId, { title, body, data }) to notify all
 * registered devices for a tenant.
 *
 * Expo Push API: https://docs.expo.dev/push-notifications/sending-notifications/
 */

const axios = require('axios');
const { createLogger } = require('../core/logger');
const { db } = require('../db/client');

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const BATCH_SIZE = 100;
const TENANT_CLAIM_KEYS = Object.freeze([
  'recipient_tenant_id',
  'tenant_id',
  'tenantId',
]);

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value);
}

/**
 * Add the authoritative recipient tenant to an Expo data payload.
 *
 * Existing direct callers may continue passing their current data fields. The
 * sender owns the tenant claim, however: a caller cannot overwrite it or add a
 * contradictory legacy alias.
 */
function buildTenantPushData(tenantId, data = {}) {
  const recipientTenantId = String(tenantId || '').trim();
  if (!recipientTenantId) throw new Error('tenantId is required');
  if (!isPlainObject(data)) throw new Error('push data must be an object');

  for (const key of TENANT_CLAIM_KEYS) {
    const claim = data[key];
    if (claim === undefined || claim === null || claim === '') continue;
    if (String(claim).trim() !== recipientTenantId) {
      const err = new Error(`push data ${key} conflicts with recipient tenant`);
      err.code = 'PUSH_TENANT_CLAIM_CONFLICT';
      throw err;
    }
  }

  return {
    ...data,
    recipient_tenant_id: recipientTenantId,
  };
}

/**
 * Send a push notification to every active device registered for a tenant.
 *
 * @param {string} tenantId - Tenant UUID
 * @param {Object} message
 * @param {string} message.title   - Notification title (shown bold)
 * @param {string} message.body    - Notification body
 * @param {Object} [message.data]  - Arbitrary JSON delivered to the app (tap payload)
 * @param {string} [message.sound] - 'default' | null
 * @param {number} [message.badge] - iOS badge count (default: 1)
 * @returns {Promise<{ sent: number, failed: number, deactivated: number }>}
 */
async function sendPushToTenant(tenantId, { title, body, data = {}, sound = 'default', badge = 1 } = {}) {
  const log = createLogger('push');

  if (!tenantId) throw new Error('tenantId is required');
  if (!title || !body) throw new Error('title and body are required');
  const tenantBoundData = buildTenantPushData(tenantId, data);

  // Load active devices for this tenant only
  const { data: devices, error } = await db
    .from('push_devices')
    .select('token')
    .eq('tenant_id', tenantId)
    .eq('active', true);

  if (error) {
    log.error('Failed to load push devices', error);
    return { sent: 0, failed: 0, deactivated: 0 };
  }

  if (!devices || devices.length === 0) {
    log.info(`No active push devices for tenant ${tenantId}`);
    return { sent: 0, failed: 0, deactivated: 0 };
  }

  const messages = devices.map(d => ({
    to: d.token,
    sound,
    title,
    body,
    data: tenantBoundData,
    badge,
    priority: 'high',
  }));

  // Send in batches (Expo limit = 100)
  const results = [];
  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    const batch = messages.slice(i, i + BATCH_SIZE);
    try {
      const res = await axios.post(EXPO_PUSH_URL, batch, {
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip, deflate',
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      });
      const batchResults = res.data?.data || [];
      batchResults.forEach((r, idx) => {
        results.push({ result: r, token: batch[idx].to });
      });
    } catch (err) {
      log.error(`Expo batch send failed`, err.message);
      batch.forEach(m => results.push({ result: { status: 'error' }, token: m.to }));
    }
  }

  // Deactivate invalid tokens
  let deactivated = 0;
  for (const { result, token } of results) {
    if (result?.status === 'error' && result?.details?.error === 'DeviceNotRegistered') {
      const { error: updErr } = await db
        .from('push_devices')
        .update({ active: false, updated_at: new Date().toISOString() })
        .eq('token', token);
      if (!updErr) deactivated++;
    }
  }

  const sent = results.filter(r => r.result?.status === 'ok').length;
  const failed = results.length - sent;

  log.success(`Push to tenant ${tenantId}: ${sent} ok, ${failed} failed, ${deactivated} deactivated`);
  return { sent, failed, deactivated };
}

/**
 * Register or update a device push token for a tenant.
 */
async function registerDevice({ tenantId, userId = null, token, platform = 'ios', deviceName = null }) {
  if (!tenantId) throw new Error('tenantId is required');
  if (!token) throw new Error('token is required');

  const now = new Date().toISOString();
  const { data, error } = await db
    .from('push_devices')
    .upsert({
      tenant_id: tenantId,
      user_id: userId,
      token,
      platform,
      device_name: deviceName,
      active: true,
      last_seen_at: now,
      updated_at: now,
    }, { onConflict: 'token' })
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Deactivate a device (e.g. on logout).
 */
async function deactivateDevice(token) {
  if (!token) return;
  await db
    .from('push_devices')
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq('token', token);
}

module.exports = {
  buildTenantPushData,
  sendPushToTenant,
  registerDevice,
  deactivateDevice,
};
