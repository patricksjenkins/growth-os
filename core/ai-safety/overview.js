/**
 * AI Safety — Dashboard Aggregation (Phase 13)
 *
 * Read-only rollups for the owner/admin AI Safety panel. Every query is
 * best-effort: a missing table (migration 046 not yet applied) yields zeros
 * rather than an error, so the panel renders "monitoring only / no data yet".
 */

'use strict';

const dbc = require('../../db/client');
const getServiceClient = () => dbc.getServiceClient();
const { snapshot } = require('./flags');
const switches = require('./switches');

function sinceIso(min) { return new Date(Date.now() - min * 60_000).toISOString(); }

async function safeSelect(buildQuery) {
  try {
    const { data, error, count } = await buildQuery(getServiceClient());
    if (error) return { data: [], count: 0 };
    return { data: data || [], count: count || 0 };
  } catch {
    return { data: [], count: 0 };
  }
}

async function countSince(min, extra = (q) => q) {
  const r = await safeSelect((db) =>
    extra(db.from('ai_usage_events').select('id', { count: 'exact', head: true }).gte('created_at', sinceIso(min)))
  );
  return r.count;
}

function groupCount(rows, key) {
  const out = {};
  for (const r of rows) {
    const k = r[key] || 'unknown';
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

/**
 * Build the full overview object for the dashboard. Never throws.
 */
async function buildOverview() {
  const snap = snapshot();

  // Pull a day's worth of usage events once, then aggregate in memory.
  const dayRows = (await safeSelect((db) =>
    db.from('ai_usage_events')
      .select('tenant_id, provider, model, agent_name, job_id, operation_type, input_tokens, output_tokens, estimated_cost_usd, untracked, outcome, created_at')
      .gte('created_at', sinceIso(24 * 60))
      .order('created_at', { ascending: false })
      .limit(20000)
  )).data;

  const hourCut = sinceIso(60);
  const hourRows = dayRows.filter((r) => r.created_at >= hourCut);

  const tokens = dayRows.reduce((a, r) => {
    a.input += Number(r.input_tokens || 0);
    a.output += Number(r.output_tokens || 0);
    return a;
  }, { input: 0, output: 0 });
  const costUsd = dayRows.reduce((s, r) => s + (Number(r.estimated_cost_usd) || 0), 0);

  // Highest-cost jobs today.
  const jobCost = {};
  for (const r of dayRows) {
    if (!r.job_id) continue;
    jobCost[r.job_id] = (jobCost[r.job_id] || 0) + (Number(r.estimated_cost_usd) || 0);
  }
  const highestCostJobs = Object.entries(jobCost)
    .sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([job_id, cost]) => ({ job_id, estimated_cost_usd: Number(cost.toFixed(4)) }));

  // Recent safety events + open switches + queue depth + batches.
  const recentEvents = (await safeSelect((db) =>
    db.from('ai_safety_events').select('*').order('created_at', { ascending: false }).limit(50)
  )).data;
  const wouldBlockCount = (await safeSelect((db) =>
    db.from('ai_safety_events').select('id', { count: 'exact', head: true })
      .eq('enforced', false).in('event_type', ['would_block', 'threshold_exceeded']).gte('created_at', sinceIso(24 * 60))
  )).count;
  const duplicateCount = (await safeSelect((db) =>
    db.from('ai_safety_events').select('id', { count: 'exact', head: true })
      .eq('event_type', 'duplicate').gte('created_at', sinceIso(24 * 60))
  )).count;
  const untrackedCount = dayRows.filter((r) => r.untracked).length;

  const queueDepth = (await safeSelect((db) =>
    db.from('agent_jobs').select('id', { count: 'exact', head: true }).eq('status', 'pending')
  )).count;
  const largeBatches = (await safeSelect((db) =>
    db.from('ai_job_batches').select('*').eq('flagged_large', true).order('created_at', { ascending: false }).limit(20)
  )).data;

  const allSwitches = await switches.listSwitches();

  return {
    state: snap.state,                 // 'monitoring_only' | 'partial_enforcement' | 'full_enforcement' | 'disabled'
    flags: snap.flags,
    thresholds: snap.thresholds,
    usage: {
      callsToday: dayRows.length,
      callsThisHour: hourRows.length,
      claudeToday: dayRows.filter((r) => r.provider === 'anthropic').length,
      geminiToday: dayRows.filter((r) => r.provider === 'google').length,
      byTenant: groupCount(dayRows, 'tenant_id'),
      byAgent: groupCount(dayRows, 'agent_name'),
      byOperation: groupCount(dayRows, 'operation_type'),
      byProvider: groupCount(dayRows, 'provider'),
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      estimatedCostUsd: Number(costUsd.toFixed(4)),
      highestCostJobs,
    },
    safety: {
      queueDepth,
      wouldHaveBlocked: wouldBlockCount,
      duplicateAttempts: duplicateCount,
      untrackedCalls: untrackedCount,
      largeBatches,
      openSwitches: allSwitches.filter((s) => s.state === 'open'),
      allSwitches,
      recentEvents,
    },
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { buildOverview };
