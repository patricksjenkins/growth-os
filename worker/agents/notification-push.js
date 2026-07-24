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

const SAFE_PAYLOAD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

/**
 * Record keys accepted by the mobile notification route registry. Values are
 * alternatives, not a raw metadata pass-through.
 */
const QUEUED_PUSH_TYPES = Object.freeze({
  approval_queue: Object.freeze({ recordKeys: [] }),
  content_plan_ready: Object.freeze({
    recordKeys: ['plan_id'],
    entityKeys: Object.freeze({ content_plan: 'plan_id' }),
  }),
  content_visual_failed: Object.freeze({
    recordKeys: ['draft_id', 'concept_id'],
    entityKeys: Object.freeze({
      content_draft: 'draft_id',
      content_plan_concept: 'concept_id',
    }),
  }),
  conversation_escalation: Object.freeze({
    recordKeys: ['conversation_id', 'lead_id', 'contact_id'],
    entityKeys: Object.freeze({
      conversation: 'conversation_id',
      lead: 'lead_id',
      contact: 'contact_id',
    }),
  }),
  review_negative_sentiment: Object.freeze({
    recordKeys: ['conversation_id', 'lead_id'],
    entityKeys: Object.freeze({
      conversation: 'conversation_id',
      lead: 'lead_id',
    }),
  }),
  inbound_sms: Object.freeze({
    recordKeys: ['message_sid', 'lead_id', 'contact_id'],
    entityKeys: Object.freeze({
      conversation: 'message_sid',
      message: 'message_sid',
      lead: 'lead_id',
      contact: 'contact_id',
    }),
  }),
  missed_call: Object.freeze({
    recordKeys: ['call_id', 'call_control_id', 'telnyx_call_control_id'],
    entityKeys: Object.freeze({
      voice_call: 'call_id',
      call: 'call_id',
    }),
  }),
  incoming_call: Object.freeze({
    recordKeys: ['call_id', 'call_control_id', 'telnyx_call_control_id', 'twilio_call_sid'],
    entityKeys: Object.freeze({
      voice_call: 'call_id',
      call: 'call_id',
    }),
  }),
  call_completed: Object.freeze({
    recordKeys: ['call_id', 'call_control_id', 'telnyx_call_control_id', 'twilio_call_sid'],
    entityKeys: Object.freeze({
      voice_call: 'call_id',
      call: 'call_id',
    }),
  }),
  lead_handoff: Object.freeze({
    recordKeys: ['lead_id'],
    entityKeys: Object.freeze({ lead: 'lead_id' }),
  }),
  finance_alert: Object.freeze({
    recordKeys: ['attention_id'],
    entityKeys: Object.freeze({
      attention: 'attention_id',
      attention_item: 'attention_id',
    }),
  }),
  ai_safety_alert: Object.freeze({
    recordKeys: ['event_id', 'notification_id'],
    entityKeys: Object.freeze({
      ai_safety_event: 'event_id',
      notification: 'notification_id',
    }),
    notificationIdKey: 'notification_id',
  }),
  email_identity_blocked: Object.freeze({ recordKeys: [] }),
  usage_cap_reached: Object.freeze({ recordKeys: [] }),
  targeted_campaign: Object.freeze({
    recordKeys: ['campaign_id'],
    entityKeys: Object.freeze({ targeted_campaign: 'campaign_id' }),
  }),
  test: Object.freeze({ recordKeys: [] }),
});

function safePayloadId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return SAFE_PAYLOAD_ID.test(normalized) ? normalized : null;
}

/**
 * Convert a queued notification row into the mobile routing contract.
 *
 * Category is authoritative for type. Metadata is treated as untrusted and
 * only individually allowlisted scalar IDs may leave the server. Message
 * content, arbitrary routes, phone numbers, tenant claims, and nested objects
 * are never copied into Expo data.
 */
function buildQueuedPushData(notification = {}) {
  const type = safePayloadId(notification.category) || 'unknown';
  const data = { type };
  const spec = QUEUED_PUSH_TYPES[type];
  if (!spec) return data;

  const metadata = notification.metadata
    && typeof notification.metadata === 'object'
    && !Array.isArray(notification.metadata)
    ? notification.metadata
    : {};

  const entityId = safePayloadId(notification.entity_id);
  const entityType = safePayloadId(notification.entity_type);
  const entityKey = entityType && spec.entityKeys
    ? spec.entityKeys[entityType]
    : null;
  if (entityId && entityKey) {
    data[entityKey] = entityId;
  }

  const notificationId = safePayloadId(notification.id);
  if (notificationId && spec.notificationIdKey) {
    data[spec.notificationIdKey] = notificationId;
  }

  for (const key of spec.recordKeys) {
    const value = safePayloadId(metadata[key]);
    if (value && !data[key]) data[key] = value;
  }

  return data;
}

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
      const data = buildQueuedPushData(notif);

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
module.exports.buildQueuedPushData = buildQueuedPushData;
module.exports.QUEUED_PUSH_TYPES = QUEUED_PUSH_TYPES;
