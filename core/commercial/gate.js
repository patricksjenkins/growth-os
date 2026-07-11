/**
 * core/commercial/gate.js — idle-by-default scheduler predicates for 923A discovery.
 *
 * Used by the cron `when` hooks so the agent only enqueues for the 923A tenant and
 * only when discovery is actually enabled + under budget. The slug check is free
 * and short-circuits for every other tenant, so 923A's Supabase is only touched
 * for 923A. Fail-safe: any error → false (do not enqueue).
 */

const supa = require('../../integrations/supabase-923a');
const budgetMod = require('./budget');

// Match by tenant id (canonical — the production slug is '923a-coins-wtlff',
// which the old exact-slug check silently rejected, so discovery never ran).
// Slug prefix kept as a fallback for environments with a different id.
function is923A(tenant) {
  if (!tenant) return false;
  if (tenant.id && String(tenant.id) === supa.tenantId()) return true;
  return typeof tenant.slug === 'string' && tenant.slug.startsWith('923a-coins');
}

// Cheap free monitor: enabled + not paused (no budget needed — no web calls).
async function monitorEnabled(tenant) {
  if (!is923A(tenant) || !supa.isConfigured()) return false;
  try { const c = await supa.getConfig(); return c.enabled && !c.paused; } catch (_) { return false; }
}

// Broad discovery: enabled + not paused + under the monthly hard-stop.
async function discoveryAllowed(tenant) {
  if (!is923A(tenant) || !supa.isConfigured()) return false;
  try {
    const c = await supa.getConfig();
    if (!c.enabled || c.paused) return false;
    const b = await budgetMod.load();
    return !b.overHardStop();
  } catch (_) { return false; }
}

// Targeted-search: discovery allowed AND at least one queued request.
async function hasQueuedTargeted(tenant) {
  if (!(await discoveryAllowed(tenant))) return false;
  try {
    const { data } = await supa.client().from('commercial_search_requests')
      .select('id').eq('tenant_id', supa.tenantId()).eq('status', 'queued').neq('query', '__agent_paused__').limit(1);
    return !!(data && data.length);
  } catch (_) { return false; }
}

module.exports = { is923A, monitorEnabled, discoveryAllowed, hasQueuedTargeted };
