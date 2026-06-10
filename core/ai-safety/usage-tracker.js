/**
 * AI Safety — Central Usage Tracker (Phase 3 + Phase 12 foundation)
 *
 * Every automated Claude/Gemini call records one row in ai_usage_events. The
 * table — not in-memory state — is the authoritative counter, so totals
 * survive process restarts and are shared across every Railway replica and
 * across the separate API + worker processes.
 *
 * MONITOR-MODE CONTRACT:
 *   - recordUsage() is best-effort and NEVER throws. A failure to write a
 *     monitoring row must not break a production provider call.
 *   - Calls missing metadata are logged as `untracked` and allowed through
 *     (no legacy-call rejection in Release 1).
 */

'use strict';

const dbc = require('../../db/client');
const getServiceClient = () => dbc.getServiceClient();
const { estimateClaudeSpendCents } = require('../usage-caps');
const { flags } = require('./flags');
const { createLogger } = require('../logger');

const log = createLogger('ai-usage');

/**
 * Best-effort insert of one usage event. Never throws.
 * @param {Object} meta
 * @returns {Promise<{recorded: boolean, untracked: boolean}>}
 */
async function recordUsage(meta = {}) {
  if (!flags.trackingEnabled()) return { recorded: false, untracked: false };

  // A call is "untracked" if it lacks the core attribution metadata. We still
  // record it (with a flag) rather than dropping it — that's how Release 1
  // measures metadata completeness without blocking anything.
  const untracked = !meta.tenantId || !meta.agentName;

  const model = meta.model || null;
  let estCostUsd = null;
  if (meta.provider !== 'google' && (meta.inputTokens || meta.outputTokens)) {
    // Reuse the existing Claude pricing table; cents -> USD.
    estCostUsd = estimateClaudeSpendCents(model, meta.inputTokens, meta.outputTokens) / 100;
  } else if (typeof meta.estimatedCostUsd === 'number') {
    estCostUsd = meta.estimatedCostUsd;
  }

  const row = {
    tenant_id: meta.tenantId || null,
    provider: meta.provider || 'anthropic',
    model,
    operation_type: meta.operationType || null,
    agent_name: meta.agentName || null,
    job_id: meta.jobId || null,
    lead_id: meta.leadId || null,
    campaign_id: meta.campaignId || null,
    campaign_stage: meta.campaignStage || null,
    initiated_by: meta.initiatedBy || (meta.isAutomated === false ? null : 'system'),
    is_automated: meta.isAutomated !== false,
    request_source: meta.requestSource || null,
    input_tokens: meta.inputTokens ?? null,
    output_tokens: meta.outputTokens ?? null,
    estimated_cost_usd: estCostUsd,
    attempt: meta.attempt || 1,
    outcome: meta.outcome || 'success',
    error: meta.error ? String(meta.error).slice(0, 500) : null,
    untracked,
  };

  try {
    const db = getServiceClient();
    const { error } = await db.from('ai_usage_events').insert(row);
    if (error) {
      // Table may not exist yet (migration 046 not applied) — degrade quietly.
      log.warn(`recordUsage insert skipped: ${error.message}`);
      return { recorded: false, untracked };
    }
    if (untracked) {
      log.warn(`Untracked AI call: provider=${row.provider} model=${model} src=${row.request_source || 'unknown'}`);
    }
    return { recorded: true, untracked };
  } catch (err) {
    log.warn(`recordUsage failed (non-fatal): ${err.message}`);
    return { recorded: false, untracked };
  }
}

/**
 * Count usage events in a trailing time window with optional filters.
 * Best-effort; returns 0 on any error so callers degrade safely.
 * @param {Object} opts { minutes, tenantId, agentName, jobId, leadId, provider }
 * @returns {Promise<number>}
 */
async function countCalls(opts = {}) {
  try {
    const db = getServiceClient();
    const sinceIso = new Date(Date.now() - (opts.minutes || 60) * 60_000).toISOString();
    let q = db.from('ai_usage_events').select('id', { count: 'exact', head: true }).gte('created_at', sinceIso);
    if (opts.tenantId) q = q.eq('tenant_id', opts.tenantId);
    if (opts.agentName) q = q.eq('agent_name', opts.agentName);
    if (opts.jobId) q = q.eq('job_id', opts.jobId);
    if (opts.leadId) q = q.eq('lead_id', opts.leadId);
    if (opts.provider) q = q.eq('provider', opts.provider);
    const { count, error } = await q;
    if (error) return 0;
    return count || 0;
  } catch {
    return 0;
  }
}

/**
 * Sum estimated cost (USD) in a trailing window. Best-effort.
 * @returns {Promise<number>}
 */
async function sumCostUsd(opts = {}) {
  try {
    const db = getServiceClient();
    const sinceIso = new Date(Date.now() - (opts.minutes || 24 * 60) * 60_000).toISOString();
    let q = db.from('ai_usage_events').select('estimated_cost_usd').gte('created_at', sinceIso);
    if (opts.tenantId) q = q.eq('tenant_id', opts.tenantId);
    const { data, error } = await q;
    if (error || !data) return 0;
    return data.reduce((s, r) => s + (Number(r.estimated_cost_usd) || 0), 0);
  } catch {
    return 0;
  }
}

module.exports = { recordUsage, countCalls, sumCostUsd };
