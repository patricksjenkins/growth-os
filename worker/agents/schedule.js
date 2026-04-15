/**
 * Growth OS — Schedule Agent (Tenant-Aware)
 * Ported from WellMor schedule-agent.js
 *
 * Assigns optimal posting times to approved content drafts.
 * Uses tenant timezone and platform best practices.
 */

const { askClaudeJSON } = require('../../integrations/claude');
const { createLogger } = require('../../core/logger');
const { getConfig } = require('../../core/config');
const { db } = require('../../db/client');

/**
 * @param {Object} tenant - Resolved tenant
 * @param {Object} payload - { week_start }
 */
async function run(tenant, payload = {}) {
  const log = createLogger('schedule', tenant.slug);

  const businessName = getConfig(tenant, 'business_name', tenant.name || 'Our Company');
  const timezone = getConfig(tenant, 'timezone', 'America/New_York');
  const platforms = getConfig(tenant, 'social_platforms', ['linkedin', 'instagram', 'facebook']);
  const postsPerMonth = getConfig(tenant, 'volume_limits', {}).posts_per_month || 15;
  const postsPerWeek = Math.ceil(postsPerMonth / 4);

  // Fetch approved but unscheduled drafts
  const { data: drafts, error: fetchErr } = await db
    .from('content_drafts')
    .select('id, platform, content_type, topic, headline, created_at')
    .eq('tenant_id', tenant.id)
    .eq('status', 'approved')
    .is('scheduled_for', null)
    .order('created_at', { ascending: true })
    .limit(postsPerWeek * platforms.length);

  if (fetchErr) throw fetchErr;

  if (!drafts || !drafts.length) {
    log.info('No approved drafts to schedule');
    return { success: true, scheduled: 0, message: 'No approved drafts' };
  }

  // Group by platform
  const byPlatform = {};
  for (const draft of drafts) {
    if (!byPlatform[draft.platform]) byPlatform[draft.platform] = [];
    byPlatform[draft.platform].push(draft);
  }

  // Generate optimal schedule
  const systemPrompt = `You are a social media strategist for ${businessName}. Create an optimal posting schedule. Timezone: ${timezone}.`;

  const userPrompt = `Schedule ${drafts.length} posts across these platforms:
${Object.entries(byPlatform).map(([p, d]) => `- ${p}: ${d.length} posts`).join('\n')}

Platform guidance:
- LinkedIn: Tue-Thu, 8-10am or 12-1pm
- Instagram: Mon-Fri, 11am-1pm or 7-9pm
- Facebook: Mon-Fri, 9-11am or 1-3pm

Return JSON: { "schedule": [{ "draft_id": "string", "platform": "string", "date": "YYYY-MM-DD", "time": "HH:MM", "reason": "string" }] }

Start from next business day. Space posts at least 4 hours apart on same platform. Max ${Math.ceil(postsPerWeek / platforms.length)} posts per platform per week.`;

  const result = await askClaudeJSON(systemPrompt, userPrompt, {
    maxTokens: 2000,
    tenantSlug: tenant.slug,
  });

  // Apply schedule
  let scheduled = 0;
  const scheduleEntries = result.schedule || [];

  for (const entry of scheduleEntries) {
    const draft = drafts.find(d => d.id === entry.draft_id);
    if (!draft) continue;

    const scheduledFor = `${entry.date}T${entry.time}:00`;

    const { error: updateErr } = await db
      .from('content_drafts')
      .update({
        scheduled_for: scheduledFor,
        status: 'scheduled',
      })
      .eq('id', draft.id)
      .eq('tenant_id', tenant.id);

    if (!updateErr) {
      scheduled++;
      log.info(`Scheduled: ${draft.platform} on ${entry.date} at ${entry.time}`);
    }
  }

  log.success(`Scheduled ${scheduled} posts`);
  return { success: true, scheduled, total_drafts: drafts.length };
}

module.exports = run;
