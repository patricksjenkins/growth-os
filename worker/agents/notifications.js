/**
 * Growth OS — Notification Service Agent (Tenant-Aware)
 * Ported from WellMor notification-service.js
 *
 * Processes pending notifications: sends email, push notifications,
 * and webhook alerts. Runs periodically to flush the notification queue.
 */

const { createLogger } = require('../../core/logger');
const { getConfig } = require('../../core/config');
const { db } = require('../../db/client');
const { sendEmail } = require('../../integrations/email');

/**
 * @param {Object} tenant - Resolved tenant
 * @param {Object} payload - { limit }
 */
async function run(tenant, payload = {}) {
  const log = createLogger('notifications', tenant.slug);

  const businessName = getConfig(tenant, 'business_name', tenant.name || 'Our Company');
  const ownerEmail = getConfig(tenant, 'digest_email', tenant.owner_email);
  const limit = Number(payload.limit || 50);

  // Fetch unsent notifications (push is handled by notification-push agent)
  const { data: notifications, error: fetchErr } = await db
    .from('notifications')
    .select('*')
    .eq('tenant_id', tenant.id)
    .eq('status', 'pending')
    .neq('channel', 'push')
    .order('created_at', { ascending: true })
    .limit(limit);

  if (fetchErr) throw fetchErr;

  if (!notifications || !notifications.length) {
    return { success: true, sent: 0, message: 'No pending notifications' };
  }

  let sent = 0;
  const errors = [];

  for (const notif of notifications) {
    try {
      const channel = notif.channel || 'email';

      if (channel === 'email' && ownerEmail) {
        // IDENTITY GUARD (2026-07-14 audit): recipient_email is an arbitrary
        // address from the notifications table. Anything that is not the
        // tenant's own owner/co-owner/digest inbox must be treated as a
        // CUSTOMER send so the tenant-identity gate applies (blocks the
        // FGA/personal From on unverified tenants) instead of silently
        // emailing a tenant's customer as the platform.
        const to = notif.recipient_email || ownerEmail;
        const ownerInboxes = [
          ownerEmail, tenant.owner_email,
          getConfig(tenant, 'owner_email', null), getConfig(tenant, 'co_owner_email', null),
        ].filter(Boolean).map((e) => String(e).trim().toLowerCase());
        const isOwnerInbox = ownerInboxes.includes(String(to).trim().toLowerCase());
        await sendEmail(
          to,
          notif.title || `${businessName} Notification`,
          `<h3>${notif.title}</h3><p>${notif.message}</p>`,
          isOwnerInbox ? { tenant } : { tenant, audience: 'customer' }
        );
      }

      // Mark as sent (tenant-scoped)
      await db
        .from('notifications')
        .update({ status: 'sent', sent_at: new Date().toISOString() })
        .eq('id', notif.id)
        .eq('tenant_id', tenant.id);

      sent++;
    } catch (err) {
      log.warn(`Notification ${notif.id} failed`, err);
      await db
        .from('notifications')
        .update({ status: 'failed', error: err.message })
        .eq('id', notif.id)
        .eq('tenant_id', tenant.id);
      errors.push({ id: notif.id, error: err.message });
    }
  }

  log.success(`Sent ${sent}/${notifications.length} notifications`);
  return { success: true, sent, failed: errors.length, errors };
}

module.exports = run;
