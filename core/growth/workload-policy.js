'use strict';

/**
 * Exact-FGA Growth Engine resource policy.
 *
 * These limits govern research and draft supply, never provider delivery.
 * Customer tenants do not consume this policy and keep their deployed paths.
 */

// First production deployment containing the complete demand-driven scheduler
// and in-agent guards. This is evidence-window metadata, not a resettable
// budget: the Command Center uses it to distinguish legacy repair consumption
// from calls made after the current control became authoritative.
const DEMAND_DRIVEN_CONTROL_ACTIVATED_AT = '2026-09-11T23:50:14.423Z';
const FGA_SUPPLY_USAGE_AGENTS = Object.freeze(['prospecting', 'enrichment', 'outreach']);

function boundedInteger(value, fallback, { min = 1, max = 100 } = {}) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function draftInventoryDays(value = process.env.FGA_DRAFT_INVENTORY_DAYS) {
  return boundedInteger(value, 2, { min: 1, max: 7 });
}

function draftInventoryTarget(dailyTarget, days = process.env.FGA_DRAFT_INVENTORY_DAYS) {
  const safeTarget = boundedInteger(dailyTarget, 25, { min: 1, max: 1000 });
  return Math.max(1, safeTarget * draftInventoryDays(days));
}

function recoveryLimits(env = process.env) {
  return Object.freeze({
    restart_ready: boundedInteger(env.FGA_RESTART_RECOVERY_DAILY_LIMIT, 25, { min: 1, max: 25 }),
    general: boundedInteger(env.FGA_GENERAL_RECOVERY_DAILY_LIMIT, 10, { min: 1, max: 25 }),
    contact: boundedInteger(env.FGA_CONTACT_RECOVERY_DAILY_LIMIT, 5, { min: 1, max: 25 }),
  });
}

function supplyProviderCallDailyCap(value = process.env.FGA_SUPPLY_PROVIDER_CALL_DAILY_CAP) {
  return boundedInteger(value, 200, { min: 25, max: 1000 });
}

function supplyProviderCostDailyCapUsd(value = process.env.FGA_SUPPLY_PROVIDER_COST_DAILY_CAP_USD) {
  const parsed = Number(value ?? 2.5);
  if (!Number.isFinite(parsed)) return 2.5;
  return Math.max(0.5, Math.min(50, Math.round(parsed * 100) / 100));
}

function qualityJudgmentDailyCap(value = process.env.FGA_QUALITY_JUDGMENT_DAILY_CAP) {
  return boundedInteger(value, 25, { min: 1, max: 100 });
}

function easternDayBounds(now = new Date()) {
  const { etParts, etDayRangeIso } = require('../revenue/daily-outcome');
  return etDayRangeIso(etParts(now).date);
}

/**
 * Daily budget for speculative FGA prospect supply. It deliberately excludes
 * provider delivery, reply handling and due follow-ups: those paths protect
 * business outcomes and must not be disabled by research consumption.
 *
 * A read failure holds new supply work. The first 1,000 rows are sufficient
 * to total cost because the enforced call ceiling cannot exceed 1,000; the
 * exact count still comes from PostgREST rather than the returned page.
 */
async function readFgaSupplyUsageBudget(client, tenantId, now = new Date()) {
  if (tenantId !== require('../config').FGA_TENANT_ID) {
    return { applicable: false, available: true, exhausted: false, reason: 'customer_tenant_unchanged' };
  }
  const callCap = supplyProviderCallDailyCap();
  const costCapUsd = supplyProviderCostDailyCapUsd();
  const { startIso, endIso } = easternDayBounds(now);
  const result = await client.from('ai_usage_events')
    .select('estimated_cost_usd', { count: 'exact' })
    .eq('tenant_id', tenantId)
    .in('agent_name', FGA_SUPPLY_USAGE_AGENTS)
    .gte('created_at', startIso)
    .lt('created_at', endIso)
    .limit(callCap);
  if (result.error) {
    return {
      applicable: true,
      available: false,
      exhausted: true,
      reason: 'supply_usage_unverified',
      calls_used: null,
      calls_cap: callCap,
      estimated_cost_usd: null,
      cost_cap_usd: costCapUsd,
      remaining_calls: 0,
      window_start: startIso,
      window_end: endIso,
    };
  }
  const returnedRows = result.data || [];
  const callsUsed = Number(result.count ?? returnedRows.length);
  // The query deliberately retrieves at most one allowed budget's worth of
  // rows. An older runaway window can therefore have an exact call count but
  // only a partial cost page. Never label that partial sum as today's cost.
  const costComplete = callsUsed <= returnedRows.length;
  const estimatedCostUsd = costComplete
    ? Number(returnedRows
      .reduce((sum, row) => sum + Number(row.estimated_cost_usd || 0), 0)
      .toFixed(4))
    : null;
  const callCapReached = callsUsed >= callCap;
  const costCapReached = costComplete && estimatedCostUsd >= costCapUsd;
  return {
    applicable: true,
    available: true,
    exhausted: callCapReached || costCapReached,
    reason: callCapReached
      ? 'supply_call_budget_exhausted'
      : costCapReached ? 'supply_cost_budget_exhausted' : 'supply_budget_available',
    calls_used: callsUsed,
    calls_cap: callCap,
    estimated_cost_usd: estimatedCostUsd,
    cost_complete: costComplete,
    cost_cap_usd: costCapUsd,
    remaining_calls: Math.max(0, callCap - callsUsed),
    window_start: startIso,
    window_end: endIso,
  };
}

/**
 * One paid quality judgment per draft, with a hard daily ceiling. Cached
 * verdicts remain usable after the ceiling; only new model work is deferred.
 */
async function readFgaQualityJudgmentBudget(client, tenantId, now = new Date()) {
  if (tenantId !== require('../config').FGA_TENANT_ID) {
    return { applicable: false, available: true, exhausted: false, reason: 'customer_tenant_unchanged' };
  }
  const cap = qualityJudgmentDailyCap();
  const { startIso, endIso } = easternDayBounds(now);
  const result = await client.from('ai_usage_events')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('agent_name', 'auto-outreach')
    .eq('operation_type', 'outreach_quality_gate')
    .gte('created_at', startIso)
    .lt('created_at', endIso);
  if (result.error) {
    return {
      applicable: true,
      available: false,
      exhausted: true,
      reason: 'quality_usage_unverified',
      judgments_used: null,
      judgments_cap: cap,
      remaining_judgments: 0,
      window_start: startIso,
      window_end: endIso,
    };
  }
  const used = Number(result.count || 0);
  return {
    applicable: true,
    available: true,
    exhausted: used >= cap,
    reason: used >= cap ? 'quality_judgment_budget_exhausted' : 'quality_judgment_budget_available',
    judgments_used: used,
    judgments_cap: cap,
    remaining_judgments: Math.max(0, cap - used),
    window_start: startIso,
    window_end: endIso,
  };
}

module.exports = {
  DEMAND_DRIVEN_CONTROL_ACTIVATED_AT,
  boundedInteger,
  draftInventoryDays,
  draftInventoryTarget,
  recoveryLimits,
  supplyProviderCallDailyCap,
  supplyProviderCostDailyCapUsd,
  qualityJudgmentDailyCap,
  readFgaSupplyUsageBudget,
  readFgaQualityJudgmentBudget,
  FGA_SUPPLY_USAGE_AGENTS,
};
