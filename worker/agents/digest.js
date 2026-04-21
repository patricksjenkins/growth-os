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
async function run(tenant, payload = {}) {
  const log = createLogger('digest', tenant.slug);

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
