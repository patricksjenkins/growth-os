/**
 * Growth OS — Twilio SMS Integration
 *
 * Enforces per-tenant monthly SMS volume caps based on subscription tier:
 *   - Growth: 500 / month
 *   - Scale:  1000 / month
 *
 * Pass `tenant` in the options bag to activate volume enforcement. When the
 * cap is reached a `SmsCapExceededError` is thrown so calling agents can
 * gracefully skip instead of failing the job.
 */

const axios = require('axios');
const { createLogger } = require('../core/logger');
const { db } = require('../db/client');
const { getConfig } = require('../core/config');

const TIER_SMS_CAPS = {
  growth: 500,
  scale: 1000,
};

class SmsCapExceededError extends Error {
  constructor(tenantId, count, cap) {
    super(`Monthly SMS cap reached for tenant ${tenantId}: ${count}/${cap}`);
    this.name = 'SmsCapExceededError';
    this.code = 'SMS_CAP_EXCEEDED';
    this.tenantId = tenantId;
    this.count = count;
    this.cap = cap;
  }
}

/**
 * Count outbound SMS sent by a tenant so far this calendar month.
 */
async function getMonthlySmsCount(tenantId) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const { count, error } = await db
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('channel', 'sms')
    .eq('direction', 'outbound')
    .gte('sent_at', monthStart);

  if (error) return 0;
  return count || 0;
}

/**
 * Resolve the monthly SMS cap for a tenant.
 *   1. tenant_config.sms_monthly_cap override (if positive)
 *   2. tier-based default (growth=500, scale=1000)
 */
function getSmsCap(tenant) {
  const override = getConfig(tenant, 'sms_monthly_cap', null);
  const overrideNum = Number(override);
  if (Number.isFinite(overrideNum) && overrideNum > 0) return overrideNum;

  const tier = getConfig(tenant, 'tier', 'growth');
  return TIER_SMS_CAPS[tier] || TIER_SMS_CAPS.growth;
}

/**
 * Send an SMS via Twilio using tenant's credentials.
 *
 * @param {Object} tenantIntegrations - tenant.integrations
 * @param {string} to - Recipient phone number
 * @param {string} body - Message text
 * @param {Object} options
 * @param {string} [options.tenantSlug]
 * @param {Object} [options.tenant] - Full tenant object; enables monthly cap enforcement
 */
async function sendSms(tenantIntegrations, to, body, options = {}) {
  const log = createLogger('twilio', options.tenantSlug);

  // Volume cap enforcement (only if full tenant passed)
  if (options.tenant && options.tenant.id) {
    const cap = getSmsCap(options.tenant);
    const count = await getMonthlySmsCount(options.tenant.id);
    if (count >= cap) {
      log.warn(`SMS cap reached (${count}/${cap}) — queuing until next cycle`);
      throw new SmsCapExceededError(options.tenant.id, count, cap);
    }
  }

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

module.exports = {
  sendSms,
  verifySignature,
  getMonthlySmsCount,
  getSmsCap,
  SmsCapExceededError,
  TIER_SMS_CAPS,
};
