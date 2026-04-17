/**
 * Growth OS — Demo-Mode Guardrail
 *
 * Central check for "is this tenant a demo tenant?" Integrations that would
 * otherwise trigger real-world side effects (SMS sends, social posts, Stripe
 * charges, outbound email) call isDemoTenant(tenant) first and skip the real
 * operation if true, returning a plausible fake success instead.
 *
 * Usage pattern (consistent across integrations):
 *   if (isDemoTenant(tenant)) {
 *     log.info('[demo] short-circuiting send for demo tenant', { ... });
 *     return { success: true, mocked: true, sid: 'demo_' + Date.now() };
 *   }
 *
 * Why a shared helper: three integrations need this check, and we want the
 * detection logic (accept a tenant object OR a tenant_id lookup) in one
 * place so it's consistent and testable.
 */

const { db } = require('../db/client');

// Small in-process cache so the tenant lookup doesn't fire on every send.
// Entries auto-expire after 5 minutes so a demo flag toggle takes effect
// within one cache window.
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();

/**
 * Is this tenant (object OR id) in demo mode?
 *
 * Accepts:
 *   - a resolved tenant object with { is_demo, id }
 *   - a tenant_id UUID string (falls back to a DB lookup)
 *   - an options object with { tenant } or { tenantId }
 *
 * Returns a boolean synchronously when given an object, or a Promise<boolean>
 * when given a bare tenant_id. Call sites generally pass the resolved tenant,
 * so the sync path is the hot path.
 */
function isDemoTenant(arg) {
  if (!arg) return false;

  // Resolved tenant object with is_demo on it
  if (typeof arg === 'object' && 'is_demo' in arg) {
    return !!arg.is_demo;
  }
  // Options object { tenant } or { tenantId }
  if (typeof arg === 'object') {
    if (arg.tenant && 'is_demo' in arg.tenant) return !!arg.tenant.is_demo;
    if (arg.tenantId) return _lookupDemoFlag(arg.tenantId);
    return false;
  }
  // Bare tenant_id string
  if (typeof arg === 'string') {
    return _lookupDemoFlag(arg);
  }
  return false;
}

async function _lookupDemoFlag(tenantId) {
  const cached = cache.get(tenantId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  const { data, error } = await db
    .from('tenants')
    .select('is_demo')
    .eq('id', tenantId)
    .maybeSingle();

  if (error) return false;
  const value = !!data?.is_demo;
  cache.set(tenantId, { value, at: Date.now() });
  return value;
}

/**
 * Build a mock "success" response that looks like a real integration
 * response. Keeps the shape consistent across call sites so downstream
 * code doesn't need to special-case demo responses.
 */
function demoMockResponse(kind, extra = {}) {
  return {
    success: true,
    mocked: true,
    kind,
    mock_id: `demo_${kind}_${Date.now()}`,
    ts: new Date().toISOString(),
    ...extra,
  };
}

module.exports = {
  isDemoTenant,
  demoMockResponse,
};
