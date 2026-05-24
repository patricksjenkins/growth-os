/**
 * Growth OS — Digest Agent
 * Generates and optionally emails a daily operational digest.
 *
 * Delegates to chief-of-staff for data, then formats and delivers.
 * Multi-tenant: uses tenant config for email settings.
 */

const { createLogger } = require('../../core/logger');
const { getConfig } = require('../../core/config');
const { sendEmail } = require('../../integrations/email');
const chiefOfStaff = require('./chief-of-staff');

/**
 * @param {Object} tenant - Resolved tenant
 * @param {Object} payload - { deliver: 'email' | 'log' }
 */
// V1 hardening (2026-05-24): centralized constant — same identifier used
// by platform-daily-digest.js. Env override happens at the core/config.js
// layer so deployments stay consistent.
const { FGA_TENANT_ID } = require('../../core/config');

async function run(tenant, payload = {}) {
  const log = createLogger('digest', tenant.slug);

  // The FGA tenant is the platform tenant — Patrick already gets a richer
  // cross-tenant view at 6:30am ET via platform-daily-digest, so emitting a
  // per-tenant 5pm digest for FGA itself just creates duplicate inbox noise.
  // Other tenants (real customers) still get their daily digest as designed.
  if (tenant.id === FGA_TENANT_ID) {
    log.info('Skipping per-tenant digest for platform tenant (covered by platform-daily-digest at 6:30am ET)');
    return { skipped: 'platform_tenant', tenant_id: tenant.id };
  }

  log.info('Generating daily digest');

  // Use chief-of-staff to build the digest
  const result = await chiefOfStaff(tenant, { type: 'digest' });

  if (!result.success) {
    throw new Error('Failed to generate digest briefing');
  }

  // Default behavior for cron runs is email delivery (it IS the end-of-day digest).
  const deliver = payload.deliver || 'email';
  const digestEmail = getConfig(tenant, 'digest_email', tenant.owner_email);
  const businessName = getConfig(tenant, 'business_name', tenant.name || 'Growth OS');
  let emailed = false;

  if (deliver === 'email') {
    if (digestEmail) {
      try {
        const html = `<pre style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; white-space: pre-wrap;">${result.digest.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>`;
        await sendEmail(
          digestEmail,
          `${businessName} — Daily Digest`,
          html,
          { tenant }
        );
        emailed = true;
        log.success(`Digest emailed to ${digestEmail}`);
      } catch (err) {
        log.warn(`Digest email failed: ${err.message}`);
      }
    } else {
      log.info('No digest_email configured; skipping email delivery');
    }
  }

  log.success('Daily digest generated', { lines: result.digest.split('\n').length, emailed });

  return {
    success: true,
    digest: result.digest,
    action_items: result.briefing.action_items.length,
    delivered_via: deliver,
    emailed,
  };
}

module.exports = run;
