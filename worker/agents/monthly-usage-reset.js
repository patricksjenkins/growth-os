/**
 * Growth OS — Monthly Usage Reset Agent
 *
 * Runs on the 1st of every month at 00:05 UTC. Resets all per-tenant
 * monthly counters in tenant_usage to 0 so the new month starts fresh.
 *
 * Daily counters (lead_capture_count_today) are NOT touched here — they
 * self-heal inside core/usage-caps.js whenever the stored date isn't today.
 *
 * Cap-reached notifications from the prior month are not cleared (they
 * live in the notifications table with their own lifecycle).
 *
 * Cron entry: '5 0 1 * *' (UTC) — see worker/scheduler/cron.js
 */

const { db } = require('../../db/client');
const { createLogger } = require('../../core/logger');

const MONTHLY_COUNTER_COLUMNS = [
  'sms_count',
  'email_send_count',
  'chat_msg_count',
  'image_gen_count',
  'twilio_voice_minutes_total',
  'outreach_send_count',
  'claude_input_tokens',
  'claude_output_tokens',
  'claude_spend_cents',
  'voice_minutes_used',
];

async function run() {
  const log = createLogger('monthly-usage-reset');

  const updates = MONTHLY_COUNTER_COLUMNS.reduce((acc, col) => {
    acc[col] = 0;
    return acc;
  }, {});
  updates.month_resets_at = new Date().toISOString();

  // Bulk update: reset every tenant_usage row at once.
  const { data, error } = await db
    .from('tenant_usage')
    .update(updates)
    .neq('tenant_id', '00000000-0000-0000-0000-000000000000') // touch every row
    .select('tenant_id');

  if (error) {
    log.error(`Monthly reset failed: ${error.message}`);
    throw error;
  }

  const count = (data || []).length;
  log.success(`Reset ${count} tenant_usage rows for the new month`);
  return { success: true, tenants_reset: count };
}

module.exports = run;
