/**
 * Growth OS Tenant Resolution
 * Loads tenant identity, config, modules, and integrations from Supabase
 */

const { createLogger } = require('./logger');
const log = createLogger('tenant');

// In-memory cache with TTL
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Resolve full tenant context from database
 * @param {Object} supabase - Supabase client (service role)
 * @param {string} tenantId - Tenant UUID
 * @returns {Object} Merged tenant object with config, modules, integrations
 */
async function resolveTenant(supabase, tenantId) {
  // Check cache
  const cached = cache.get(tenantId);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return cached.data;
  }

  // Fetch all tenant data in parallel
  const [tenantRes, configRes, modulesRes, integrationsRes] = await Promise.all([
    supabase.from('tenants').select('*').eq('id', tenantId).single(),
    supabase.from('tenant_config').select('key, value').eq('tenant_id', tenantId),
    supabase.from('tenant_modules').select('module, enabled, config').eq('tenant_id', tenantId),
    supabase.from('tenant_integrations').select('service, credentials, config, status').eq('tenant_id', tenantId)
  ]);

  if (tenantRes.error || !tenantRes.data) {
    throw new Error(`Tenant not found: ${tenantId}`);
  }

  const tenant = {
    ...tenantRes.data,
    config: {},
    modules: {},
    integrations: {}
  };

  // Flatten config rows into key-value object
  if (configRes.data) {
    for (const row of configRes.data) {
      tenant.config[row.key] = row.value;
    }
  }

  // Flatten modules into { moduleName: { enabled, ...config } }
  if (modulesRes.data) {
    for (const row of modulesRes.data) {
      tenant.modules[row.module] = {
        enabled: row.enabled,
        ...(row.config || {})
      };
    }
  }

  // Flatten integrations into { service: { credentials, config, status } }
  if (integrationsRes.data) {
    for (const row of integrationsRes.data) {
      tenant.integrations[row.service] = {
        credentials: row.credentials || {},
        config: row.config || {},
        status: row.status
      };
    }
  }

  // Cache it
  cache.set(tenantId, { data: tenant, ts: Date.now() });

  return tenant;
}

/**
 * Clear cached tenant data (call after config updates)
 */
function clearTenantCache(tenantId) {
  if (tenantId) {
    cache.delete(tenantId);
  } else {
    cache.clear();
  }
}

module.exports = { resolveTenant, clearTenantCache };
