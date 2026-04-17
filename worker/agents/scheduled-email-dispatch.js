/**
 * Growth OS — Scheduled Email Dispatcher
 *
 * Polls the scheduled_emails table for rows where send_at <= NOW() and
 * status = 'pending', renders and sends each, then marks them sent.
 *
 * Used by the onboarding workflow to deliver the Day 21 / Day 37 / Day 67
 * check-in emails (which are inserted with a future send_at at the
 * "schedule_checkins" step on Day 7).
 *
 * Errors don't block the run — each row is handled independently and
 * marked status='failed' with the error message for later retry/debug.
 */

const { createLogger } = require('../../core/logger');
const { db } = require('../../db/client');
const email = require('../../integrations/email');

/**
 * @param {Object} tenant - Resolved tenant
 * @param {Object} payload - { limit? }
 */
async function run(tenant, payload = {}) {
  const log = createLogger('scheduled-email-dispatch', tenant.slug);
  const limit = Number(payload.limit || 50);
  const now = new Date().toISOString();

  const { data: due, error } = await db
    .from('scheduled_emails')
    .select('*')
    .eq('tenant_id', tenant.id)
    .eq('status', 'pending')
    .lte('send_at', now)
    .order('send_at', { ascending: true })
    .limit(limit);

  if (error) throw error;
  if (!due || !due.length) {
    return { success: true, sent: 0, message: 'No emails due' };
  }

  let sent = 0;
  let failed = 0;
  const errors = [];

  for (const row of due) {
    try {
      const options = row.subject ? { subject: row.subject } : {};
      await email.sendTemplateEmail(
        row.to_email,
        row.template_name,
        row.template_vars || {},
        options
      );

      await db
        .from('scheduled_emails')
        .update({ status: 'sent', sent_at: new Date().toISOString() })
        .eq('id', row.id)
        .eq('tenant_id', tenant.id);

      sent++;
      log.info(`Sent scheduled email ${row.id} (${row.template_name}) to ${row.to_email}`);
    } catch (err) {
      failed++;
      const msg = err?.message || String(err);
      log.error(`Scheduled email ${row.id} failed: ${msg}`);
      errors.push({ id: row.id, template: row.template_name, error: msg });
      await db
        .from('scheduled_emails')
        .update({ status: 'failed', error: msg })
        .eq('id', row.id)
        .eq('tenant_id', tenant.id);
    }
  }

  log.success(`Dispatched ${sent}/${due.length} scheduled emails (${failed} failed)`);
  return { success: true, sent, failed, errors };
}

module.exports = run;
