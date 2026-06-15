/**
 * First Gen Automate — Telnyx Messaging Integration
 *
 * Replaces the Twilio SMS path. Same `sendSms(tenantIntegrations, to, body,
 * options)` signature as integrations/twilio.js so the 13 callers don't change.
 *
 * Sending model (decided 2026-06):
 *   - Platform-owned Telnyx account. ONE API key (TELNYX_API_KEY).
 *   - Each TENANT has its own Telnyx number (per-tenant inbound routing — an
 *     inbound text is attributed to a tenant by the number it was sent TO).
 *   - All tenant numbers sit under FGA's messaging profile, which is tied to
 *     the approved 10DLC campaign (TELNYX_MESSAGING_PROFILE_ID). That keeps
 *     every tenant's SMS compliant under the First Gen Automate LLC brand.
 *
 * Required env (set in Railway):
 *   TELNYX_API_KEY                 — Telnyx → API Keys
 *   TELNYX_MESSAGING_PROFILE_ID    — profile linked to the approved campaign
 *   TELNYX_PUBLIC_KEY              — for webhook signature verification (webhooks)
 *
 * Per-tenant from-number resolution order:
 *   1. tenantIntegrations.telnyx.config.phone_number
 *   2. tenant_config.telnyx_phone_number  (via getConfig)
 *   3. TELNYX_PHONE_NUMBER env (FGA's own number — fallback for FGA itself)
 */

const axios = require('axios');
const { createLogger } = require('../core/logger');
const { db } = require('../db/client');
const { getConfig } = require('../core/config');

const TELNYX_API = 'https://api.telnyx.com/v2';

const TIER_SMS_CAPS = { growth: 500, scale: 1000 };

class SmsCapExceededError extends Error {
  constructor(tenantId, count, cap) {
    super(`Monthly SMS cap reached for tenant ${tenantId}: ${count}/${cap}`);
    this.name = 'SmsCapExceededError';
    this.code = 'SMS_CAP_EXCEEDED';
    this.tenantId = tenantId; this.count = count; this.cap = cap;
  }
}

/** Thrown when a tenant has no Telnyx sending number configured yet. */
class TelnyxNotConfiguredError extends Error {
  constructor(tenantId) {
    super(`No Telnyx phone number configured for tenant ${tenantId}. Provision one and store it on the tenant's telnyx integration (config.phone_number).`);
    this.name = 'TelnyxNotConfiguredError';
    this.code = 'TELNYX_NOT_CONFIGURED';
    this.tenantId = tenantId;
  }
}

/**
 * Compatibility shim. The old Twilio path threw A2PUnregisteredError when a
 * number wasn't 10DLC-registered; several agents `catch (err instanceof
 * A2PUnregisteredError)`. On Telnyx the campaign is approved at the messaging
 * profile level, so this is never thrown — but we export the class so those
 * catch blocks keep compiling/working unchanged.
 */
class A2PUnregisteredError extends Error {
  constructor(tenantId, fromNumber) {
    super(`Number ${fromNumber} for tenant ${tenantId} is not registered for A2P 10DLC.`);
    this.name = 'A2PUnregisteredError';
    this.code = 'A2P_UNREGISTERED';
    this.tenantId = tenantId; this.from = fromNumber;
  }
}

/** Count outbound SMS this calendar month (channel-agnostic — same as before). */
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

function getSmsCap(tenant) {
  const override = Number(getConfig(tenant, 'sms_monthly_cap', null));
  if (Number.isFinite(override) && override > 0) return override;
  const tier = getConfig(tenant, 'tier', 'growth');
  return TIER_SMS_CAPS[tier] || TIER_SMS_CAPS.growth;
}

/** Resolve this tenant's Telnyx sending number. */
function resolveFromNumber(tenantIntegrations, tenant) {
  return (
    tenantIntegrations?.telnyx?.config?.phone_number ||
    (tenant ? getConfig(tenant, 'telnyx_phone_number', null) : null) ||
    process.env.TELNYX_PHONE_NUMBER ||
    null
  );
}

/**
 * Send an SMS via Telnyx. Drop-in replacement for twilio.sendSms.
 *
 * @param {Object} tenantIntegrations - tenant.integrations
 * @param {string} to - recipient phone (E.164)
 * @param {string} body - message text
 * @param {Object} options
 * @param {string} [options.tenantSlug]
 * @param {Object} [options.tenant] - full tenant; enables caps + demo guard
 * @returns {Promise<Object>} normalized { sid, to, status, raw }
 */
async function sendSms(tenantIntegrations, to, body, options = {}) {
  const log = createLogger('telnyx', options.tenantSlug);

  // Demo-mode guard — never hit the API or charge for demo tenants.
  const { isDemoTenant, demoMockResponse } = require('./demo-guard');
  if (options.tenant && isDemoTenant(options.tenant)) {
    log.info(`[demo] SMS mocked — would have sent to ${String(to).slice(-4)}: "${String(body).slice(0, 60)}"`);
    return demoMockResponse('sms', { sid: `demo_sms_${Date.now()}`, to, status: 'delivered' });
  }

  // Monthly volume cap.
  if (options.tenant && options.tenant.id) {
    const cap = getSmsCap(options.tenant);
    const count = await getMonthlySmsCount(options.tenant.id);
    if (count >= cap) {
      log.warn(`SMS cap reached (${count}/${cap}) — queuing until next cycle`);
      throw new SmsCapExceededError(options.tenant.id, count, cap);
    }
  }

  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) throw new Error('TELNYX_API_KEY not set');

  const from = resolveFromNumber(tenantIntegrations, options.tenant);
  if (!from) throw new TelnyxNotConfiguredError(options.tenant?.id);

  const messagingProfileId =
    (options.tenant ? getConfig(options.tenant, 'telnyx_messaging_profile_id', null) : null) ||
    process.env.TELNYX_MESSAGING_PROFILE_ID ||
    null;

  // Delivery receipts (DLRs) + inbound both land on the messaging profile's
  // webhook (configured in the Telnyx portal → Messaging Profiles → Webhook
  // URL = <API_BASE>/webhooks/telnyx). We also set webhook_url explicitly as
  // a belt-and-suspenders so status updates route even if the profile webhook
  // is missing.
  const apiBase = process.env.API_BASE_URL || process.env.PUBLIC_API_URL || 'https://growth-os-production-22b3.up.railway.app';
  const webhookUrl = `${apiBase.replace(/\/$/, '')}/webhooks/telnyx`;

  const payload = {
    from,
    to,
    text: body,
    webhook_url: webhookUrl,
    use_profile_webhooks: true,
  };
  if (messagingProfileId) payload.messaging_profile_id = messagingProfileId;

  const response = await axios.post(`${TELNYX_API}/messages`, payload, {
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
  });

  const id = response.data?.data?.id || null;
  log.success(`SMS sent to ${String(to).slice(-4)}`);

  // Fire-and-forget usage increment (never let it break a send).
  if (options.tenant && options.tenant.id) {
    try {
      const { incrementUsage } = require('../core/usage-caps');
      incrementUsage(options.tenant.id, 'sms_count', 1).catch(() => {});
    } catch (_) { /* ignore */ }
  }
  // Usage-based cost on the AI/usage ledger (provider=telnyx). Rate is
  // per-message; override TELNYX_SMS_COST_USD. Agent/tenant from context.
  try {
    require('../core/ai-safety/usage-tracker').recordUsage({
      tenantId: options.tenant?.id, provider: 'telnyx', model: 'sms', operationType: 'sms_send',
      estimatedCostUsd: Number(process.env.TELNYX_SMS_COST_USD || 0.004),
      isAutomated: options.isAutomated !== false, requestSource: 'integrations/telnyx.js:sendSms',
    }).catch(() => {});
  } catch (_) { /* never break a send */ }

  return { sid: id, to, status: 'queued', raw: response.data };
}

/**
 * Provision a new local US number on the platform Telnyx account and attach it
 * to the messaging profile (which carries the approved 10DLC campaign).
 * Drop-in replacement for the old twilio.provisionLocalNumber.
 *
 * @returns {Promise<{phone_number, sid, area_code, friendly_name}>}
 */
async function provisionLocalNumber(opts = {}) {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) throw new Error('TELNYX_API_KEY required for provisioning');
  const log = createLogger('telnyx-provision', opts.tenantSlug);
  const areaCode = String(opts.areaCode || '470');
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  const messagingProfileId = opts.messagingProfileId || process.env.TELNYX_MESSAGING_PROFILE_ID;

  log.info(`Searching available US numbers (area code ${areaCode})…`);
  const search = await axios.get(`${TELNYX_API}/available_phone_numbers`, {
    headers,
    params: {
      'filter[country_code]': 'US',
      'filter[national_destination_code]': areaCode,
      'filter[features][]': 'sms',
      'filter[limit]': 5,
      'filter[best_effort]': true,
    },
  });
  const candidate = search.data?.data?.[0]?.phone_number;
  if (!candidate) throw new Error(`No SMS-capable numbers available in area code ${areaCode}`);
  log.info(`Candidate: ${candidate}`);

  const order = await axios.post(`${TELNYX_API}/number_orders`, {
    phone_numbers: [{ phone_number: candidate }],
    ...(messagingProfileId ? { messaging_profile_id: messagingProfileId } : {}),
  }, { headers });

  const ordered = order.data?.data?.phone_numbers?.[0];
  log.success(`Provisioned ${candidate} (order ${order.data?.data?.id})`);
  return {
    phone_number: candidate,
    sid: ordered?.id || order.data?.data?.id || null,
    area_code: areaCode,
    friendly_name: opts.friendlyName || `First Gen Automate — ${opts.tenantSlug || 'tenant'}`,
  };
}

/**
 * Attach a Telnyx number to the messaging profile (for SMS) and optionally a
 * voice connection (for inbound-call / missed-call events). Replacement for
 * twilio.configureNumberWebhooks — on Telnyx, inbound SMS + DLR webhooks live
 * on the messaging profile, so the meaningful action is assigning the profile.
 *
 * @param {string} phoneNumberId — Telnyx phone number id
 * @param {Object} opts — { messagingProfileId?, connectionId? }
 */
async function configureNumberWebhooks(phoneNumberId, opts = {}) {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) throw new Error('TELNYX_API_KEY required');
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  const body = {};
  const profile = opts.messagingProfileId || process.env.TELNYX_MESSAGING_PROFILE_ID;
  if (profile) body.messaging_profile_id = profile;
  if (opts.connectionId) body.connection_id = opts.connectionId;
  if (Object.keys(body).length === 0) return null;
  const res = await axios.patch(`${TELNYX_API}/phone_numbers/${phoneNumberId}`, body, { headers });
  return res.data?.data || null;
}

module.exports = {
  sendSms,
  getMonthlySmsCount,
  getSmsCap,
  resolveFromNumber,
  provisionLocalNumber,
  configureNumberWebhooks,
  SmsCapExceededError,
  TelnyxNotConfiguredError,
  A2PUnregisteredError,
  TIER_SMS_CAPS,
};
