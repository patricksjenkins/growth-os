/**
 * AI Safety — Kill Switches & Circuit Breakers (Phase 6 + Phase 7)
 *
 * Persistent (DB-backed) switches that survive restarts and are shared across
 * processes. Two kinds share one table:
 *   - kill_switch    — manual on/off for a scope (global/provider/tenant/agent/job_type)
 *   - circuit_breaker— same scopes, but intended for automatic tripping later
 *
 * ENFORCEMENT CONTRACT (Release 1):
 *   isBlocked() ALWAYS returns { blocked: false } unless the matching
 *   enforcement flag is ON (providerKillSwitch / agentKillSwitch /
 *   circuitBreaker), which all default OFF. So switches are pure
 *   monitoring/manual records today and never interrupt live traffic.
 *
 * Every state change is fully audited (previous, new, actor, reason, scope,
 * timestamp) per Phase 7.
 */

'use strict';

const dbc = require('../../db/client');
const getServiceClient = () => dbc.getServiceClient();
const { flags } = require('./flags');
const { createLogger } = require('../logger');

const log = createLogger('ai-switches');

/**
 * Fetch the matching switches for a call's scopes. Best-effort; on any error
 * returns [] so the caller degrades to "no switch = allowed".
 */
async function _matchingSwitches(meta = {}) {
  try {
    const db = getServiceClient();
    // Build the set of (scope, scope_value) tuples this call belongs to.
    const tuples = [['global', '*']];
    if (meta.provider) tuples.push(['provider', meta.provider]);
    if (meta.tenantId) tuples.push(['tenant', meta.tenantId]);
    if (meta.agentName) tuples.push(['agent', meta.agentName]);
    if (meta.jobType) tuples.push(['job_type', meta.jobType]);

    const { data, error } = await db
      .from('ai_safety_switches')
      .select('*')
      .eq('state', 'open');
    if (error || !data) return [];
    const tupleSet = new Set(tuples.map(([s, v]) => `${s}:${v}`));
    return data.filter((row) => tupleSet.has(`${row.scope}:${row.scope_value}`));
  } catch {
    return [];
  }
}

/**
 * Decide whether a provider call is blocked by an open switch/breaker.
 * Returns { blocked, reason, scope, kind, enforced }.
 *
 * In Release 1 (enforcement flags off) blocked is ALWAYS false; when an open
 * switch is found it is reported with enforced=false so the wrapper can log a
 * "would_block" monitor event without stopping the call.
 */
async function evaluate(meta = {}) {
  const open = await _matchingSwitches(meta);
  if (!open.length) return { blocked: false, open: [] };

  // Is enforcement active for any of the matched kinds/scopes?
  const enforcementOn = (row) => {
    if (row.kind === 'circuit_breaker') return flags.circuitBreaker();
    // kill_switch:
    if (row.scope === 'provider') return flags.providerKillSwitch();
    if (row.scope === 'agent') return flags.agentKillSwitch();
    // global/tenant/job_type kill switches gate on the broad hardLimits lever.
    return flags.hardLimits();
  };

  const enforcing = open.filter(enforcementOn);
  const blocked = enforcing.length > 0;
  const top = (blocked ? enforcing : open)[0];

  // Human-initiated chat exemption (Phase 6): never block a real person.
  if (blocked && meta.isAutomated === false) {
    return { blocked: false, open, exempt: 'human_initiated' };
  }

  return {
    blocked,
    enforced: blocked,
    reason: top.reason || `${top.kind}_open`,
    scope: top.scope,
    scopeValue: top.scope_value,
    kind: top.kind,
    open,
  };
}

/**
 * Manually set a switch/breaker state with full audit (Phase 7).
 * @returns {Promise<{ok: boolean, switch?: object, error?: string}>}
 */
async function setSwitch({ kind, scope, scopeValue = '*', state, reason, actor = 'system', autoReactivate = false, trigger = {} }) {
  if (!['kill_switch', 'circuit_breaker'].includes(kind)) return { ok: false, error: 'invalid_kind' };
  if (!['closed', 'open'].includes(state)) return { ok: false, error: 'invalid_state' };
  try {
    const db = getServiceClient();
    const { data: existing } = await db
      .from('ai_safety_switches')
      .select('*')
      .eq('kind', kind).eq('scope', scope).eq('scope_value', scopeValue)
      .maybeSingle();

    const previousState = existing ? existing.state : 'closed';
    const patch = {
      kind, scope, scope_value: scopeValue, state, reason: reason || null,
      auto_reactivate: autoReactivate, trigger_detail: trigger || {},
      opened_at: state === 'open' ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    };

    let row;
    if (existing) {
      const { data, error } = await db.from('ai_safety_switches').update(patch).eq('id', existing.id).select().single();
      if (error) return { ok: false, error: error.message };
      row = data;
    } else {
      const { data, error } = await db.from('ai_safety_switches').insert(patch).select().single();
      if (error) return { ok: false, error: error.message };
      row = data;
    }

    // Audit trail — never let an audit-write failure undo the state change.
    try {
      await db.from('ai_safety_switch_audit').insert({
        switch_id: row.id, kind, scope, scope_value: scopeValue,
        previous_state: previousState, new_state: state, actor, reason: reason || null,
      });
    } catch (auditErr) {
      log.warn(`switch audit insert failed: ${auditErr.message}`);
    }

    log.info(`switch ${kind}/${scope}/${scopeValue}: ${previousState} -> ${state} by ${actor}`);
    return { ok: true, switch: row };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * List all switches (for the dashboard). Best-effort.
 */
async function listSwitches() {
  try {
    const db = getServiceClient();
    const { data, error } = await db.from('ai_safety_switches').select('*').order('updated_at', { ascending: false });
    return error ? [] : (data || []);
  } catch {
    return [];
  }
}

module.exports = { evaluate, setSwitch, listSwitches };
