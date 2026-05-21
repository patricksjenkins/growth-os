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
 * Thrown when a tenant tries to send SMS from a Twilio number that
 * hasn't been registered for US A2P 10DLC. Carriers silently drop
 * messages from unregistered numbers with error 30034. Surfacing this
 * pre-flight so callers can record the failure instead of recording a
 * false "sent" then never hearing about delivery.
 */
class A2PUnregisteredError extends Error {
  constructor(tenantId, fromNumber) {
    super(`Twilio number ${fromNumber} for tenant ${tenantId} is not registered for A2P 10DLC — US carriers will drop the SMS. Register the number in Twilio Console → Messaging → A2P 10DLC.`);
    this.name = 'A2PUnregisteredError';
    this.code = 'A2P_UNREGISTERED';
    this.tenantId = tenantId;
    this.from = fromNumber;
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

  // Demo-mode guard — short-circuit before hitting Twilio's API so demo
  // tenants never incur real SMS charges or deliver real messages.
  const { isDemoTenant, demoMockResponse } = require('./demo-guard');
  if (options.tenant && isDemoTenant(options.tenant)) {
    log.info(`[demo] SMS mocked — would have sent to ${to.slice(-4)}: "${String(body).slice(0, 60)}"`);
    return demoMockResponse('sms', {
      sid: `demo_sms_${Date.now()}`,
      to, status: 'delivered',
    });
  }

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

  // A2P 10DLC guard — US carriers drop SMS from unregistered Twilio
  // numbers with error 30034 (silently, after Twilio's API accepts the
  // POST). To stop the platform from logging false "sent" rows that
  // never reach the recipient, require an explicit
  // tenant_config.twilio_a2p_registered=true flag before sending. Flip
  // the flag manually once the A2P 10DLC Brand + Campaign + number
  // assignment is approved in Twilio Console. Override per-tenant with
  // tenant_config.twilio_a2p_skip_check=true (only for international
  // numbers / non-US destinations).
  if (options.tenant && options.tenant.id) {
    const skipCheck = getConfig(options.tenant, 'twilio_a2p_skip_check', false) === true;
    const a2pRegistered = getConfig(options.tenant, 'twilio_a2p_registered', false) === true;
    if (!skipCheck && !a2pRegistered) {
      log.warn(`A2P 10DLC not registered for ${from} — refusing to send (would have been silently dropped by US carriers)`);
      throw new A2PUnregisteredError(options.tenant.id, from);
    }
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${account_sid}/Messages.json`;

  // Tell Twilio where to POST the delivery status webhook so we can
  // record actual delivered/undelivered/failed status instead of just
  // the immediate API-accepted "sent" state. The webhook is mounted at
  // /webhooks/twilio/status (api/webhooks/twilio.js).
  const apiBase = process.env.API_BASE_URL || process.env.PUBLIC_API_URL || 'https://growth-os-production-22b3.up.railway.app';
  const statusCallback = `${apiBase.replace(/\/$/, '')}/webhooks/twilio/status`;

  const params = new URLSearchParams();
  params.append('To', to);
  params.append('From', from);
  params.append('Body', body);
  params.append('StatusCallback', statusCallback);

  const response = await axios.post(url, params.toString(), {
    auth: { username: account_sid, password: auth_token },
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });

  log.success(`SMS sent to ${to.slice(-4)}`);

  // Increment per-tenant SMS counter (fire-and-forget).
  // The existing SmsCapExceededError path covers the pre-send check via
  // getMonthlySmsCount; this is the post-send increment so the cap-check
  // logic in usage-caps.js sees the running total too.
  if (options.tenant && options.tenant.id) {
    try {
      const { incrementUsage } = require('../core/usage-caps');
      incrementUsage(options.tenant.id, 'sms_count', 1).catch(() => {});
    } catch (_) { /* never let usage tracking break a send */ }
  }
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

/**
 * Provision a new local US phone number for a tenant via the platform
 * Twilio account. Uses TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN platform
 * creds (the same ones that send onboarding-flow SMS).
 *
 * Strategy:
 *   1. Search availablePhoneNumbers.local in the tenant's state if
 *      configured, else US area code 470 (Atlanta — Patrick's market).
 *   2. Buy the first SMS+voice-capable result via incomingPhoneNumbers.create.
 *   3. Return { phone_number, sid, area_code }.
 *
 * Caller (typically the asset-gen worker or admin onboard handler)
 * persists the result to tenant_config.twilio_phone_number +
 * tenant_config.twilio_phone_sid.
 *
 * Idempotency is on the caller — pass `existingNumber` to short-circuit.
 *
 * @param {Object} opts
 * @param {string} [opts.areaCode] - preferred US area code (default 470)
 * @param {string} [opts.tenantSlug] - for logging
 * @param {string} [opts.friendlyName] - shows in Twilio console
 * @returns {Promise<{phone_number, sid, area_code}>}
 */
async function provisionLocalNumber(opts = {}) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    throw new Error('TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN required for provisioning');
  }
  const log = createLogger('twilio-provision', opts.tenantSlug);

  const areaCode = String(opts.areaCode || '470');
  const friendlyName = opts.friendlyName || `Growth OS — ${opts.tenantSlug || 'tenant'}`;

  const twilio = require('twilio')(accountSid, authToken);

  log.info(`Searching for available local US numbers (area code ${areaCode})…`);
  const available = await twilio.availablePhoneNumbers('US').local.list({
    areaCode,
    smsEnabled: true,
    voiceEnabled: true,
    limit: 5,
  });
  if (!available.length) {
    throw new Error(`No SMS+voice-capable numbers available in area code ${areaCode}`);
  }
  const candidate = available[0];
  log.info(`Candidate: ${candidate.phoneNumber}`);

  const purchased = await twilio.incomingPhoneNumbers.create({
    phoneNumber: candidate.phoneNumber,
    friendlyName,
  });
  log.success(`Provisioned ${purchased.phoneNumber} (sid: ${purchased.sid})`);

  return {
    phone_number: purchased.phoneNumber,
    sid: purchased.sid,
    area_code: areaCode,
    friendly_name: friendlyName,
  };
}

/**
 * Configure the SMS + voice webhook URLs on a Twilio-owned number.
 * Called from app-asset-pipeline after a number is bought, AND whenever
 * a tenant later enables voice_receptionist on a previously-SMS-only
 * number.
 *
 * @param {string} phoneNumberSid — Twilio incomingPhoneNumbers SID
 * @param {Object} urls — { smsUrl?, voiceUrl?, voiceFallbackUrl?, statusCallback? }
 * @returns {Promise<Object>} updated number resource
 */
async function configureNumberWebhooks(phoneNumberSid, urls = {}) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) throw new Error('TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN required');
  const twilio = require('twilio')(accountSid, authToken);

  const updates = {};
  if (urls.smsUrl) { updates.smsUrl = urls.smsUrl; updates.smsMethod = 'POST'; }
  if (urls.voiceUrl) { updates.voiceUrl = urls.voiceUrl; updates.voiceMethod = 'POST'; }
  if (urls.voiceFallbackUrl) { updates.voiceFallbackUrl = urls.voiceFallbackUrl; updates.voiceFallbackMethod = 'POST'; }
  if (urls.statusCallback) { updates.statusCallback = urls.statusCallback; updates.statusCallbackMethod = 'POST'; }

  if (Object.keys(updates).length === 0) return null;
  return twilio.incomingPhoneNumbers(phoneNumberSid).update(updates);
}

module.exports = {
  sendSms,
  A2PUnregisteredError,
  verifySignature,
  getMonthlySmsCount,
  getSmsCap,
  SmsCapExceededError,
  TIER_SMS_CAPS,
  provisionLocalNumber,
  configureNumberWebhooks,
};
