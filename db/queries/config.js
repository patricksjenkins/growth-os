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
  const { data, error } = await db
    .from('tenant_integrations')
    .select('tenant_id, config')
    .eq('service', 'twilio');
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
  getTenantById,
  getTenantBySlug,
  findTenantByPhone,
  getTenantConfig,
  upsertConfig,
  getTenantModules,
  getTenantIntegrations
};
