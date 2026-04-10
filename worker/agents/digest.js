/**
 * Growth OS — Digest Agent
 * Generates and optionally emails a daily operational digest.
 *
 * Delegates to chief-of-staff for data, then formats and delivers.
 * Multi-tenant: uses tenant config for email settings.
 */

const { createLogger } = require('../../core/logger');
const { getConfig } = require('../../core/config');
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

  const deliver = payload.deliver || 'log';

  if (deliver === 'email') {
    // Future: send via SMTP integration
    const digestEmail = getConfig(tenant, 'digest_email', null);
    if (digestEmail) {
      log.info(`Would send digest to ${digestEmail} (email delivery not yet implemented)`);
      // TODO: integrate with SMTP/SendGrid when communication agents are ported
    }
  }

  log.success('Daily digest generated', { lines: result.digest.split('\n').length });

  return {
    success: true,
    digest: result.digest,
    action_items: result.briefing.action_items.length,
    delivered_via: deliver
  };
}

module.exports = run;
