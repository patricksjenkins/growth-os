/**
 * Growth OS — Push Notification Dispatcher (Tenant-Aware)
 *
 * Processes pending push notifications in the notifications queue for a
 * tenant, sends them via Expo Push, and marks them sent/failed.
 *
 * Runs every 5 minutes per tenant (see worker/scheduler/cron.js).
 *
 * Device registration is handled at `/api/notifications/register-device`
 * (api/routes/notifications.js). Actual send uses `integrations/push.js`.
 */

const { createLogger } = require('../../core/logger');
const { db } = require('../../db/client');
const { sendPushToTenant } = require('../../integrations/push');

/**
 * @param {Object} tenant - Resolved tenant
 * @param {Object} payload - { limit }
 */
async function run(tenant, payload = {}) {
  const log = createLogger('notification-push', tenant.slug);
  const limit = Number(payload.limit || 50);

  // Fetch pending push notifications for this tenant
  const { data: notifications, error: fetchErr } = await db
    .from('notifications')
    .select('*')
    .eq('tenant_id', tenant.id)
    .eq('channel', 'push')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(limit);

  if (fetchErr) throw fetchErr;

  if (!notifications || !notifications.length) {
    return { success: true, sent: 0, message: 'No pending push notifications' };
  }

  let sent = 0;
  let failed = 0;
  const errors = [];

  for (const notif of notifications) {
    try {
      const title = notif.title || 'Notification';
      const body = notif.message || '';
      const data = notif.metadata || {};

      const result = await sendPushToTenant(tenant.id, { title, body, data });

      if (result.sent > 0) {
        sent++;
        await db
          .from('notifications')
          .update({
            status: 'sent',
            sent_at: new Date().toISOString(),
            metadata: { ...(notif.metadata || {}), push_result: result },
          })
          .eq('id', notif.id)
          .eq('tenant_id', tenant.id);
      } else {
        // No devices, or all failed — mark as skipped so we don't retry forever
        await db
          .from('notifications')
          .update({
            status: result.failed > 0 ? 'failed' : 'skipped',
            sent_at: new Date().toISOString(),
            metadata: { ...(notif.metadata || {}), push_result: result },
          })
          .eq('id', notif.id)
          .eq('tenant_id', tenant.id);
        if (result.failed > 0) failed++;
      }
    } catch (err) {
      failed++;
      log.warn(`Push notification ${notif.id} failed`, err);
      await db
        .from('notifications')
        .update({ status: 'failed', error: err.message })
        .eq('id', notif.id)
        .eq('tenant_id', tenant.id);
      errors.push({ id: notif.id, error: err.message });
    }
  }

  log.success(`Push dispatch: ${sent} sent, ${failed} failed`);
  return { success: true, sent, failed, errors };
}

module.exports = run;
