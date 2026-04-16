/**
 * Growth OS — Social Engagement Agent (Tenant-Aware)
 *
 * Scale-tier feature (CLAUDE.md): comment monitoring, liking, responding
 * on posted social content. Runs twice daily per tenant.
 *
 * STATUS: Stub implementation. Platform-specific engagement APIs (LinkedIn,
 * Instagram, Facebook) are not yet wired up. This agent currently records
 * a no-op run and exits cleanly so the cron/job processor does not fail.
 *
 * Future scope:
 *  - Pull recently posted items from content_drafts where status = 'posted'
 *  - For each post, call platform API to list new comments since last check
 *  - Classify comments (positive / question / negative) via Claude
 *  - Auto-like positive comments (up to "Unlimited" per Scale tier cap)
 *  - Draft responses to questions (up to 300 / month per Scale tier cap)
 *  - Queue drafts for owner approval via approval-queue agent
 */

const { createLogger } = require('../../core/logger');
const { db } = require('../../db/client');

/**
 * @param {Object} tenant - Resolved tenant
 * @param {Object} payload - unused
 */
async function run(tenant, _payload = {}) {
  const log = createLogger('social-engagement', tenant.slug);

  // Activity log so we can see it is firing, even as a no-op.
  await db.from('activity_log').insert({
    tenant_id: tenant.id,
    agent: 'social-engagement',
    action: 'stub_run',
    entity_type: 'system',
    metadata: {
      note: 'Engagement monitoring not yet implemented; no-op stub executed.',
    },
  });

  log.info('Social engagement stub ran (no-op pending platform integration)');
  return {
    success: true,
    stub: true,
    message: 'Social engagement agent is a pending Scale-tier feature.',
  };
}

module.exports = run;
