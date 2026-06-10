/**
 * AI Safety — Guarded Enqueue Service (Phase 11)
 *
 * The intended single front door for creating agent_jobs in bulk. A 104-lead
 * backfill becomes ONE ai_job_batches row (item_count = 104) plus 104 jobs
 * tagged with that batch_id — so a burst is visible and cancellable as a unit
 * instead of 104 unrelated jobs that each slip under a per-run limit.
 *
 * RELEASE 1 CONTRACT:
 *   - Nothing is blocked. Large batches are flagged + alerted (monitor-only).
 *   - Manual approval gating only activates when AI_MANUAL_BATCH_APPROVAL_ENABLED
 *     is true (default false), in which case a large batch is recorded as
 *     'pending_approval' and its jobs are NOT enqueued until approved.
 *   - Hand-run scripts SHOULD call this instead of inserting into agent_jobs
 *     directly; direct inserts still work but bypass batch tracking (a known,
 *     documented remaining gap until scripts are migrated).
 */

'use strict';

const dbc = require('../../db/client');
const getServiceClient = () => dbc.getServiceClient();
const { flags, thresholds } = require('./flags');
const events = require('./events');
const { createLogger } = require('../logger');

const log = createLogger('ai-guarded-enqueue');

/**
 * Create a tracked batch and enqueue its jobs.
 *
 * @param {Object} params
 * @param {string} params.tenantId
 * @param {string} params.agentName        agent the jobs target (e.g. 'outreach')
 * @param {Array<Object>} params.items     per-job payloads (e.g. [{lead_id}, ...])
 * @param {string} [params.source]         'admin_route' | 'manual_script' | 'enrichment_auto'
 * @param {string} [params.reason]         human/script reason tag
 * @param {string} [params.createdBy]
 * @param {number} [params.priority=0]
 * @returns {Promise<{ok:boolean, batchId?:string, enqueued:number, flaggedLarge:boolean, pendingApproval:boolean, error?:string}>}
 */
async function guardedEnqueue(params = {}) {
  const { tenantId, agentName, items = [], source = 'unknown', reason = null, createdBy = 'system', priority = 0 } = params;
  if (!agentName || !Array.isArray(items)) {
    return { ok: false, enqueued: 0, flaggedLarge: false, pendingApproval: false, error: 'agentName and items[] required' };
  }

  const count = items.length;
  const threshold = thresholds.batchApprovalThreshold();
  const flaggedLarge = count >= threshold;
  const approvalOn = flags.manualBatchApproval();
  const pendingApproval = flaggedLarge && approvalOn;

  const db = getServiceClient();

  // 1) Record the batch (best-effort). If the table is missing we still enqueue
  //    (degrade safely) but without batch linkage.
  let batchId = null;
  try {
    const { data, error } = await db.from('ai_job_batches').insert({
      tenant_id: tenantId || null,
      source, reason, agent_name: agentName, item_count: count,
      status: pendingApproval ? 'pending_approval' : 'open',
      flagged_large: flaggedLarge, created_by: createdBy,
      detail: { priority },
    }).select('id').single();
    if (!error && data) batchId = data.id;
  } catch (err) {
    log.warn(`batch insert skipped: ${err.message}`);
  }

  // 2) Flag + alert large batches (monitor-only record).
  if (flaggedLarge) {
    await events.logEvent({
      eventType: 'large_batch', severity: pendingApproval ? 'warning' : 'info',
      rule: 'batch_approval_threshold', scope: 'tenant', scopeValue: tenantId,
      enforced: pendingApproval, tenantId, agentName,
      detail: { count, threshold, source, reason, batchId, held_for_approval: pendingApproval },
    });
    await events.alert({
      dedupKey: `large_batch:${agentName}:${tenantId}:${reason || source}`,
      severity: pendingApproval ? 'warning' : 'info', rule: 'large_batch',
      tenantId, agentName, detail: { count, threshold, source, reason, batchId },
    });
  }

  // 3) If approval gating is active and this batch is large, DON'T enqueue yet.
  if (pendingApproval) {
    log.warn(`Batch held for approval: ${count} ${agentName} jobs (threshold ${threshold})`);
    return { ok: true, batchId, enqueued: 0, flaggedLarge, pendingApproval: true };
  }

  // 4) Enqueue the jobs, tagged with batch_id.
  const rows = items.map((payload) => ({
    tenant_id: tenantId || null,
    agent_name: agentName,
    payload: payload || {},
    status: 'pending',
    priority,
    batch_id: batchId,
  }));
  try {
    const { error } = await db.from('agent_jobs').insert(rows);
    if (error) {
      // Retry WITHOUT batch_id in case the additive column isn't present yet.
      const fallback = rows.map(({ batch_id, ...r }) => r);
      const { error: err2 } = await db.from('agent_jobs').insert(fallback);
      if (err2) return { ok: false, batchId, enqueued: 0, flaggedLarge, pendingApproval: false, error: err2.message };
    }
  } catch (err) {
    return { ok: false, batchId, enqueued: 0, flaggedLarge, pendingApproval: false, error: err.message };
  }

  // 5) Mark the batch completed (open->completed) once jobs are enqueued.
  if (batchId) {
    try { await db.from('ai_job_batches').update({ status: 'completed', updated_at: new Date().toISOString() }).eq('id', batchId); } catch (_) { /* non-fatal */ }
  }

  return { ok: true, batchId, enqueued: count, flaggedLarge, pendingApproval: false };
}

module.exports = { guardedEnqueue };
