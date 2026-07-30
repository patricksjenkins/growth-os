/**
 * Tenant & Config Queries
 */

const { db } = require('../client');

/**
 * Get all active tenants (for scheduler)
 */
async function getAllActiveTenants() {
  const { data, error } = await db
    .from('tenants')
    .select('*')
    .eq('status', 'active');
  if (error) throw error;
  return data || [];
}

/**
 * Statuses a tenant holds while it is being onboarded, before go-live flips it
 * to 'active'. Written by api/routes/onboarding.js, api/routes/admin.js
 * (onboard-tenant), and api/routes/tenant.js (wizard completion).
 */
const ONBOARDING_STATUSES = ['onboarding', 'onboarding_intake_complete'];

/**
 * Tenants currently mid-onboarding.
 *
 * WHY THIS IS SEPARATE FROM getAllActiveTenants (2026-07-30)
 * The scheduler iterates `getAllActiveTenants()` for every cron entry, and
 * that query is `status = 'active'` exactly. A tenant being onboarded is not
 * 'active', so the `onboarding-advance` job — the thing whose entire purpose
 * is to move onboarding along — never saw a single tenant it was meant to
 * advance. `onboarding_workflows` has zero rows in production, ever.
 *
 * The fix is NOT to widen getAllActiveTenants. Doing that would run every
 * other cron for onboarding tenants too: prospecting, outbound email, finance,
 * publishing. A tenant that has not finished its intake form must not start
 * cold-emailing anyone. So onboarding gets its own scope, and only the jobs
 * that ask for it iterate these tenants.
 */
async function getOnboardingTenants() {
  const { data, error } = await db
    .from('tenants')
    .select('*')
    .in('status', ONBOARDING_STATUSES);
  if (error) throw error;
  return data || [];
}

/**
 * Get tenant by ID
 */
async function getTenantById(tenantId) {
  const { data, error } = await db
    .from('tenants')
    .select('*')
    .eq('id', tenantId)
    .single();
  if (error) throw error;
  return data;
}

/**
 * Get tenant by slug
 */
async function getTenantBySlug(slug) {
  const { data, error } = await db
    .from('tenants')
    .select('*')
    .eq('slug', slug)
    .single();
  if (error) throw error;
  return data;
}

/**
 * Find tenant by phone number (for Twilio webhook routing)
 */
async function findTenantByPhone(phoneNumber) {
  // Match the tenant whose messaging number equals the destination number.
  // Telnyx is the active SMS/voice provider; 'twilio' kept only for any
  // lingering rows during the cutover.
  const { data, error } = await db
    .from('tenant_integrations')
    .select('tenant_id, config, service')
    .in('service', ['telnyx', 'twilio']);
  if (error) throw error;

  for (const row of (data || [])) {
    if (row.config?.phone_number === phoneNumber) {
      return getTenantById(row.tenant_id);
    }
  }
  return null;
}

/**
 * Get all config for a tenant
 */
async function getTenantConfig(tenantId) {
  const { data, error } = await db
    .from('tenant_config')
    .select('key, value')
    .eq('tenant_id', tenantId);
  if (error) throw error;
  const config = {};
  for (const row of (data || [])) {
    config[row.key] = row.value;
  }
  return config;
}

/**
 * Upsert a single config key
 */
async function upsertConfig(tenantId, key, value) {
  const { data, error } = await db
    .from('tenant_config')
    .upsert(
      { tenant_id: tenantId, key, value },
      { onConflict: 'tenant_id,key' }
    )
    .select()
    .single();
  if (error) throw error;
  return data;
}

/**
 * Get tenant modules
 */
async function getTenantModules(tenantId) {
  const { data, error } = await db
    .from('tenant_modules')
    .select('module, enabled, config')
    .eq('tenant_id', tenantId);
  if (error) throw error;
  return data || [];
}

/**
 * Get tenant integrations
 */
async function getTenantIntegrations(tenantId) {
  const { data, error } = await db
    .from('tenant_integrations')
    .select('service, credentials, config, status')
    .eq('tenant_id', tenantId);
  if (error) throw error;
  return data || [];
}

module.exports = {
  getAllActiveTenants,
  getOnboardingTenants,
  ONBOARDING_STATUSES,
  getTenantById,
  getTenantBySlug,
  findTenantByPhone,
  getTenantConfig,
  upsertConfig,
  getTenantModules,
  getTenantIntegrations
};
