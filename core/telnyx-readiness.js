'use strict';

const { getConfig } = require('./config');
function isPlatformTenantForEnv(tenant, env) {
  if (!tenant) return false;
  const platformSlug = env.PLATFORM_TENANT_SLUG || 'fga';
  const platformId = env.FGA_TENANT_ID;
  return tenant.slug === platformSlug
    || (platformId && String(tenant.id) === String(platformId))
    || tenant.is_platform === true
    || tenant.config?.is_platform === true
    || tenant.config?.is_platform === 'true';
}

function tenantTelnyxNumber(tenant, env = process.env) {
  const configured =
    tenant?.integrations?.telnyx?.config?.phone_number
    || getConfig(tenant, 'telnyx_phone_number', null);
  if (configured) return String(configured).trim() || null;
  if (tenant && !isPlatformTenantForEnv(tenant, env)) return null;
  return String(env.TELNYX_PHONE_NUMBER || '').trim() || null;
}

function telnyxMessagingReadiness(tenant, env = process.env) {
  const reasons = [];
  const integration = tenant?.integrations?.telnyx;
  const number = tenantTelnyxNumber(tenant, env);
  if (!number) reasons.push('tenant_telnyx_number_missing');
  if (!env.TELNYX_API_KEY) reasons.push('telnyx_api_key_missing');
  if (integration?.status && integration.status !== 'active') {
    reasons.push('tenant_telnyx_integration_inactive');
  }
  return {
    ready: reasons.length === 0,
    provider: 'telnyx',
    reasons,
    has_tenant_number: Boolean(number),
  };
}

function hasTelnyxMessaging(tenant, env = process.env) {
  return telnyxMessagingReadiness(tenant, env).ready;
}

module.exports = {
  hasTelnyxMessaging,
  telnyxMessagingReadiness,
  tenantTelnyxNumber,
};
