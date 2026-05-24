/**
 * Growth OS Tenant Resolution
 * Loads tenant identity, config, modules, and integrations from Supabase
 */

const { createLogger } = require('./logger');
const log = createLogger('tenant');

// V1 hardening (2026-05-24): LRU-bounded in-memory cache. The original
// unbounded Map grew without eviction — at 1,000+ tenants × ~30KB each
// the process slowly leaked memory until restart. Now capped at 200
// entries; least-recently-USED gets evicted on overflow.
//
// Note: this is still per-process. On Railway with >1 dyno, config
// changes propagated by the admin endpoint don't invalidate caches on
// other dynos for up to CACHE_TTL. Acceptable for V1 (single-dyno) —
// when we scale horizontally, swap this for a Supabase Realtime
// subscription that broadcasts invalidations.
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const CACHE_MAX_ENTRIES = 200;
const cache = new Map();         // insertion order = LRU order

function lruTouch(tenantId, value) {
  // Map iteration order is insertion order; deleting + re-setting
  // moves the key to the tail = most-recently-used.
  if (cache.has(tenantId)) cache.delete(tenantId);
  cache.set(tenantId, value);
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * Resolve full tenant context from database
 * @param {Object} supabase - Supabase client (service role)
 * @param {string} tenantId - Tenant UUID
 * @returns {Object} Merged tenant object with config, modules, integrations
 */
async function resolveTenant(supabase, tenantId) {
  // Check cache (LRU + TTL)
  const cached = cache.get(tenantId);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    // Bump to most-recently-used.
    lruTouch(tenantId, cached);
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

  // V1 hardening (2026-05-24): scrub credentials when the tenant object
  // is JSON-serialized (e.g. accidental console.log, Sentry capture,
  // res.json(tenant)). The credentials are still accessible to code that
  // walks tenant.integrations[X].credentials directly — only serialization
  // is filtered.
  Object.defineProperty(tenant, 'toJSON', {
    enumerable: false,
    value() {
      const scrubbed = { ...this };
      if (scrubbed.integrations) {
        scrubbed.integrations = Object.fromEntries(
          Object.entries(scrubbed.integrations).map(([svc, val]) => [
            svc,
            { ...val, credentials: val.credentials ? '[REDACTED]' : {} },
          ])
        );
      }
      return scrubbed;
    },
  });

  // Cache it via LRU-bounded helper.
  lruTouch(tenantId, { data: tenant, ts: Date.now() });

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

/**
 * V1 hardening (2026-05-24): wire a Supabase Realtime subscription so
 * tenant-config/module/integration changes propagate to every dyno's
 * in-memory cache within ~1 second. Without this, multi-dyno deploys
 * serve stale tenant state for up to CACHE_TTL (5 min) after Patrick
 * disables a module.
 *
 * Call this ONCE per process at boot — typically from api/server.js or
 * worker/index.js. Idempotent: safe to call twice; second call no-ops.
 *
 * Requires Supabase Realtime to be enabled on these tables in the
 * Supabase dashboard:
 *   - tenants
 *   - tenant_config
 *   - tenant_modules
 *   - tenant_integrations
 *
 * Migration step (run once in the SQL editor):
 *   alter publication supabase_realtime add table public.tenants,
 *     public.tenant_config, public.tenant_modules, public.tenant_integrations;
 */
let realtimeSubscribed = false;
function subscribeToTenantInvalidations(supabase) {
  if (realtimeSubscribed) return;
  realtimeSubscribed = true;
  try {
    const channel = supabase
      .channel('tenant-cache-invalidations')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tenant_config' },
        (payload) => {
          const tid = payload.new?.tenant_id || payload.old?.tenant_id;
          if (tid) cache.delete(tid);
        })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tenant_modules' },
        (payload) => {
          const tid = payload.new?.tenant_id || payload.old?.tenant_id;
          if (tid) cache.delete(tid);
        })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tenant_integrations' },
        (payload) => {
          const tid = payload.new?.tenant_id || payload.old?.tenant_id;
          if (tid) cache.delete(tid);
        })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tenants' },
        (payload) => {
          const tid = payload.new?.id || payload.old?.id;
          if (tid) cache.delete(tid);
        })
      .subscribe();
    log.info('Subscribed to tenant cache invalidations via Supabase Realtime');
    return channel;
  } catch (err) {
    log.warn(`Could not subscribe to Realtime invalidations: ${err.message}`);
    realtimeSubscribed = false;
  }
}

module.exports = { resolveTenant, clearTenantCache, subscribeToTenantInvalidations };
