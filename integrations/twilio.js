/**
 * Growth OS — Twilio SMS Integration
 */

const axios = require('axios');
const { createLogger } = require('../core/logger');

/**
 * Send an SMS via Twilio using tenant's credentials
 * @param {Object} tenantIntegrations - tenant.integrations
 * @param {string} to - Recipient phone number
 * @param {string} body - Message text
 * @param {Object} options
 */
async function sendSms(tenantIntegrations, to, body, options = {}) {
  const log = createLogger('twilio', options.tenantSlug);
  const twilio = tenantIntegrations?.twilio;

  if (!twilio || !twilio.credentials?.account_sid) {
    throw new Error('Twilio integration not configured for this tenant');
  }

  const { account_sid, auth_token } = twilio.credentials;
  const from = twilio.config?.phone_number;

  if (!from) throw new Error('Twilio phone number not configured');

  const url = `https://api.twilio.com/2010-04-01/Accounts/${account_sid}/Messages.json`;

  const params = new URLSearchParams();
  params.append('To', to);
  params.append('From', from);
  params.append('Body', body);

  const response = await axios.post(url, params.toString(), {
    auth: { username: account_sid, password: auth_token },
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });

  log.success(`SMS sent to ${to.slice(-4)}`);
  return response.data;
}

/**
 * Verify Twilio webhook signature
 */
function verifySignature(tenantIntegrations, signature, url, params) {
  // TODO: Implement Twilio signature verification
  // For now, return true (webhook signing will be added when Twilio is configured)
  return true;
}

module.exports = { sendSms, verifySignature };
