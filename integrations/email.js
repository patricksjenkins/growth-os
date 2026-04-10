/**
 * Growth OS — Email Integration
 * Stub — will be fleshed out when outreach-drip agent is ported
 */

const { createLogger } = require('../core/logger');

/**
 * Send an email via tenant's SMTP config
 */
async function sendEmail(tenantIntegrations, to, subject, body, options = {}) {
  const log = createLogger('email', options.tenantSlug);
  // TODO: Implement with nodemailer using tenant_integrations.smtp credentials
  log.warn(`Email sending not yet implemented. Would send to: ${to}`);
  return { status: 'stub', to, subject };
}

module.exports = { sendEmail };
