/**
 * Operations Guardian — controlled self-healing for FGA's own platform agents.
 *
 * Flow each run (scheduled — the guardian never triggers itself):
 *   1. VERIFY open incidents (did the agent recover? did a retry work?).
 *   2. DETECT new problems from agent_jobs + business output (read-only).
 *   3. REMEDIATE Level-1-safe issues automatically (bounded), or ESCALATE.
 *
 * Hard safety rules:
 *   - The guardian itself calls NO paid API. Diagnosis is rules-based.
 *   - The ONLY automatic action is re-enqueuing an existing agent job through
 *     the normal queue, so it inherits every cap, the pace gate, and the
 *     callClaude chokepoint.
 *   - Auto-requeue is restricted to NON-outbound agents (SAFE_TO_REQUEUE), so
 *     remediation can never cause a surprise external SMS/email.
 *   - Per-incident: max 2 attempts, cooldown between attempts, circuit breaker
 *     (then escalate to owner approval). Cost guard skips retries during spend
 *     spikes. Scoped to the FGA tenant only — no client-side side effects.
 *   - Code / migration / env / prompt / cap / outbound / spend changes are
 *     NEVER auto-applied; they always become owner-approval items.
 */

const { getServiceClient } = require('../../db/client');
const { enqueueJob } = require('../../db/queries/jobs');
const { getSchedule } = require('../../worker/scheduler/cron');
const { FGA_TENANT_ID } = require('../config');
const { sendCriticalAlert } = require('../monitoring');
const { createLogger } = require('../logger');
const { buildCadenceMap, errorSignature, classifyError } = require('./diagnose');

const log = createLogger('ops-guardian');

// ── Safeguard constants (tunable via env) ──────────────────────────────────
const MAX_ATTEMPTS      = Number(process.env.OPS_MAX_ATTEMPTS || 2);       // circuit breaker
const COOLDOWN_MS       = Number(process.env.OPS_COOLDOWN_MS || 2 * 3600_000); // 2h between attempts
const STUCK_JOB_MS      = Number(process.env.OPS_STUCK_JOB_MS || 30 * 60_000); // processing > 30m = stuck
const COST_GUARD_USD    = Number(process.env.OPS_COST_GUARD_USD || 15);    // skip retries if today's spend exceeds this
const COST_SPIKE_USD    = Number(process.env.OPS_COST_SPIKE_USD || 20);    // flag a cost spike above this
const WEEKLY_LEAD_TARGET = Number(process.env.OPS_WEEKLY_LEAD_TARGET || 50);
const LOOKBACK_DAYS     = 8;

// Agents a re-run is safe for: internal / draft-producing / idempotent. Anything
// that sends SMS/email to real people is intentionally excluded — those escalate
// to an approval item instead of auto-retrying.
const SAFE_TO_REQUEUE = new Set([
  'prospecting', 'enrichment', 'scoring', 'lead-scoring',
  'content-plan', 'content-generation', 'content-concept-finalize',
  'image-generation', 'system-monitor', 'platform-daily-digest', 'chief-of-staff',
  'reply-classification', 'advertising', 'prospecting-orchestrator',
]);

const ACTIVE = ['open', 'remediating', 'awaiting_approval', 'escalated'];

function dayKey(iso) { return String(iso).slice(0, 10); }
function nowIso() { return new Date().toISOString(); }

// ---------------------------------------------------------------------------
// Data gathering (read-only) — FGA tenant only.
// ---------------------------------------------------------------------------

async function gatherAgentStats(db) {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86400_000).toISOString();
  const { data, error } = await db
    .from('agent_jobs')
    .select('id,agent_name,status,error,created_at,started_at,completed_at')
    .eq('tenant_id', FGA_TENANT_ID)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(5000);
  if (error) { log.warn(`agent_jobs read failed: ${error.message}`); return {}; }

  const stats = {};
  for (const j of (data || [])) {
    const a = (stats[j.agent_name] ||= {
      agent: j.agent_name, runs_24h: 0, failed_24h: 0, runs_7d: 0, failed_7d: 0,
      last_attempt_at: null, last_success_at: null, last_error: null,
      consec_failures: 0, _consecOpen: true, sigs: {}, recent_job_ids: [], stuck: [],
    });
    const within24h = j.created_at >= new Date(Date.now() - 86400_000).toISOString();
    a.runs_7d++; if (within24h) a.runs_24h++;
    if (!a.last_attempt_at) a.last_attempt_at = j.created_at;
    if (a.recent_job_ids.length < 10) a.recent_job_ids.push(j.id);

    if (j.status === 'failed') {
      a.failed_7d++; if (within24h) a.failed_24h++;
      if (a._consecOpen) a.consec_failures++;
      if (!a.last_error) a.last_error = j.error || '';
      const sig = errorSignature(j.error);
      a.sigs[sig] = (a.sigs[sig] || 0) + 1;
    } else if (j.status === 'completed' || j.status === 'success') {
      a._consecOpen = false; // newest success ends the consecutive-failure streak
      if (!a.last_success_at) a.last_success_at = j.completed_at || j.created_at;
    } else if (j.status === 'processing') {
      if (j.started_at && Date.now() - new Date(j.started_at).getTime() > STUCK_JOB_MS) a.stuck.push(j.id);
    }
  }
  return stats;
}

async function gatherProspecting(db) {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86400_000).toISOString();
  const { data } = await db.from('leads')
    .select('created_at')
    .eq('tenant_id', FGA_TENANT_ID).eq('lead_source', 'prospecting_agent')
    .gte('created_at', since);
  const byDay = {};
  for (const l of (data || [])) byDay[dayKey(l.created_at)] = (byDay[dayKey(l.created_at)] || 0) + 1;
  const today = dayKey(nowIso());
  const weekAgo = dayKey(new Date(Date.now() - 7 * 86400_000).toISOString());
  let leadsToday = byDay[today] || 0;
  let leadsWeek = 0; for (const [d, n] of Object.entries(byDay)) if (d > weekAgo) leadsWeek += n;
  // consecutive zero-output days ending yesterday (today may still be in progress)
  let zero = 0;
  for (let d = 1; d <= LOOKBACK_DAYS; d++) {
    const k = dayKey(new Date(Date.now() - d * 86400_000).toISOString());
    if ((byDay[k] || 0) === 0) zero++; else break;
  }
  return { leadsToday, leadsWeek, consecutiveZeroDays: zero };
}

async function gatherCostToday(db) {
  const midnight = new Date(); midnight.setUTCHours(0, 0, 0, 0);
  const { data } = await db.from('ai_usage_events')
    .select('estimated_cost_usd')
    .gte('created_at', midnight.toISOString()).limit(20000);
  let total = 0; for (const r of (data || [])) total += Number(r.estimated_cost_usd || 0);
  return total;
}

// ---------------------------------------------------------------------------
// Incident persistence + safeguards.
// ---------------------------------------------------------------------------

async function findOpenIncident(db, agent, issueType) {
  const { data } = await db.from('ops_incidents').select('*')
    .eq('agent_name', agent).eq('issue_type', issueType).in('status', ACTIVE)
    .order('detected_at', { ascending: false }).limit(1);
  return (data && data[0]) || null;
}

async function upsertIncident(db, fields) {
  const existing = await findOpenIncident(db, fields.agent_name, fields.issue_type);
  if (existing) {
    const { data } = await db.from('ops_incidents').update({
      severity: fields.severity, latest_error: fields.latest_error,
      error_signature: fields.error_signature, business_impact: fields.business_impact,
      diagnosis_summary: fields.diagnosis_summary, affected_jobs: fields.affected_jobs,
      links_to_logs: fields.links_to_logs, updated_at: nowIso(),
    }).eq('id', existing.id).select('*').single();
    return data || existing;
  }
  const { data } = await db.from('ops_incidents').insert({
    tenant_id: FGA_TENANT_ID, status: 'open', permission_level: 1, ...fields,
  }).select('*').single();
  return data;
}

async function recordRemediation(db, incident, action, level, result, extra = {}) {
  const attempts = Array.isArray(incident.remediation_attempted) ? incident.remediation_attempted : [];
  attempts.push({ at: nowIso(), action, level, result });
  const patch = {
    remediation_attempted: attempts, remediation_result: result, updated_at: nowIso(), ...extra,
  };
  await db.from('ops_incidents').update(patch).eq('id', incident.id);
  // Platform audit trail.
  await db.from('agent_activity_log').insert({
    tenant_id: FGA_TENANT_ID, agent_name: 'operations-guardian', action: 'ops_remediation',
    status: 'success', details: { incident_id: incident.id, agent: incident.agent_name, action, level, result },
  }).then(() => {}, () => {});
  Object.assign(incident, patch);
}

async function escalate(db, incident, level, reason, summary, severity) {
  // Create an owner-approval / attention item once (idempotent on incident).
  let attentionId = incident.attention_queue_id;
  if (!attentionId) {
    const { data } = await db.from('attention_queue').insert({
      tenant_id: FGA_TENANT_ID, type: 'ops_incident',
      severity: severity === 'red' ? 'red' : 'amber',
      title: `${incident.agent_name}: ${summary}`,
      summary: `${incident.diagnosis_summary || ''} ${reason}`.trim(),
      entity_type: 'ops_incident', entity_id: incident.id,
      payload: { agent: incident.agent_name, issue_type: incident.issue_type, level, latest_error: incident.latest_error },
      quick_actions: [{ label: 'Open Agent Hub', href: '/admin/agent-hub' }],
      produced_by: 'operations-guardian',
    }).select('id').single();
    attentionId = data && data.id;
  }
  await db.from('ops_incidents').update({
    permission_level: level, requires_owner_approval: true, approval_reason: reason,
    status: level >= 3 ? 'escalated' : 'awaiting_approval', attention_queue_id: attentionId,
    severity, updated_at: nowIso(),
  }).eq('id', incident.id);
  // Level 3 (or red) also pages the founder — once.
  if ((level >= 3 || severity === 'red') && !incident.attention_queue_id) {
    await sendCriticalAlert(`Operations Guardian: ${incident.agent_name} — ${summary}. ${incident.diagnosis_summary || ''} Owner action needed.`)
      .catch(() => {});
  }
}

function cooldownOk(incident) {
  if (!incident.last_attempt_at) return true;
  return Date.now() - new Date(incident.last_attempt_at).getTime() >= COOLDOWN_MS;
}

// ---------------------------------------------------------------------------
// Main run.
// ---------------------------------------------------------------------------

async function runGuardian(opts = {}) {
  const dryRun = !!opts.dryRun;   // preview: detect + decide, but no writes/requeues/escalations
  const plan = [];
  const db = getServiceClient();
  const cadence = buildCadenceMap(getSchedule());
  const stats = await gatherAgentStats(db);
  const prospecting = await gatherProspecting(db);
  const costToday = await gatherCostToday(db);
  const costGuardTripped = costToday > COST_GUARD_USD;

  const summary = { detected: 0, remediated: 0, escalated: 0, recovered: 0, cost_today: Number(costToday.toFixed(2)) };

  // ---- PASS 1: verify/auto-recover existing active incidents ----
  const { data: active } = await db.from('ops_incidents').select('*').in('status', ACTIVE);
  for (const inc of (active || [])) {
    const s = stats[inc.agent_name];
    const recoveredSince = s && s.last_success_at &&
      new Date(s.last_success_at).getTime() > new Date(inc.last_attempt_at || inc.detected_at).getTime();
    // For zero-output incidents, "recovered" means output resumed.
    const outputResumed = inc.issue_type === 'zero_output' && prospecting.consecutiveZeroDays === 0;
    if (recoveredSince || outputResumed) {
      if (!dryRun) await db.from('ops_incidents').update({
        status: 'recovered', verification_result: 'recovered', resolved_at: nowIso(),
        remediation_result: (inc.remediation_result || '') + ' | verified recovered', updated_at: nowIso(),
      }).eq('id', inc.id);
      summary.recovered++;
      continue;
    }
    // Still failing after a retry → circuit-break to owner approval.
    if (inc.status === 'remediating' && inc.attempt_count >= MAX_ATTEMPTS) {
      if (!dryRun) {
        const cls = classifyError(inc.latest_error);
        await escalate(db, inc, Math.max(2, cls.level),
          `Auto-retry attempted ${inc.attempt_count}× and the agent is still failing — needs ${cls.category === 'provider_network' || cls.category === 'parser' ? 'code-level diagnosis' : 'owner action'}.`,
          inc.business_impact || 'agent still failing', inc.severity);
        await db.from('ops_incidents').update({ verification_result: 'still_failing', updated_at: nowIso() }).eq('id', inc.id);
      }
      summary.escalated++;
    }
  }

  // ---- PASS 2: detect + remediate ----
  const detected = [];

  // Per-agent run-health rules.
  for (const [agent, s] of Object.entries(stats)) {
    const cls = classifyError(s.last_error);

    // Rule: a scheduled, unconditional agent overdue past its cadence.
    const cad = cadence[agent];
    if (cad && cad.unconditional && cad.maxGapHours) {
      const staleMs = cad.maxGapHours * 3600_000 * 1.4 + 2 * 3600_000;
      const lastOk = s.last_success_at ? new Date(s.last_success_at).getTime() : 0;
      if (Date.now() - lastOk > staleMs) {
        detected.push({ agent, issue_type: 'no_successful_run', severity: 'red',
          business_impact: `Scheduled agent has not succeeded in ${Math.round((Date.now() - lastOk) / 3600_000)}h (expected at least every ~${cad.maxGapHours}h).`,
          latest_error: s.last_error, error_signature: errorSignature(s.last_error), cls, stats: s });
      }
    }
    // Rule: 3+ consecutive failures.
    if (s.consec_failures >= 3) {
      detected.push({ agent, issue_type: 'consecutive_failures', severity: 'red',
        business_impact: `${s.consec_failures} consecutive failed runs.`,
        latest_error: s.last_error, error_signature: errorSignature(s.last_error), cls, stats: s });
    }
    // Rule: same error signature repeats 2+ times.
    const topSig = Object.entries(s.sigs).sort((a, b) => b[1] - a[1])[0];
    // Only flag if the agent is CURRENTLY failing (newest run failed). A
    // recovered agent's historical errors must not raise a fresh incident.
    if (topSig && topSig[1] >= 2 && s.consec_failures >= 1 && s.consec_failures < 3) {
      const rl = /rate|limit|429|quota|credit|401|403|unauthorized|key/.test(topSig[0]);
      detected.push({ agent, issue_type: rl ? 'rate_limit' : 'repeated_error', severity: rl ? 'red' : 'amber',
        business_impact: `Same error repeated ${topSig[1]}× in ${LOOKBACK_DAYS}d.`,
        latest_error: s.last_error, error_signature: topSig[0], cls, stats: s });
    }
    // Rule: stuck jobs.
    if (s.stuck.length) {
      detected.push({ agent, issue_type: 'stuck_jobs', severity: 'amber',
        business_impact: `${s.stuck.length} job(s) stuck in 'processing' > ${Math.round(STUCK_JOB_MS / 60000)}m.`,
        latest_error: null, error_signature: 'stuck', cls: { recoverable: true, level: 1, category: 'stuck' },
        stuck: s.stuck, stats: s });
    }
  }

  // Prospecting business-output rules.
  if (prospecting.consecutiveZeroDays >= 2) {
    const ps = stats['prospecting'] || {};
    detected.push({ agent: 'prospecting', issue_type: 'zero_output', severity: 'red',
      business_impact: `0 leads created for ${prospecting.consecutiveZeroDays} straight days (weekly target ${WEEKLY_LEAD_TARGET}; this week: ${prospecting.leadsWeek}). Prospecting pipeline not being replenished.`,
      latest_error: ps.last_error || null, error_signature: errorSignature(ps.last_error), cls: classifyError(ps.last_error), stats: ps });
  }

  // Cost spike (escalate-only, never auto-act).
  if (costToday > COST_SPIKE_USD) {
    detected.push({ agent: 'platform', issue_type: 'cost_spike', severity: 'red',
      business_impact: `Today's AI spend is $${costToday.toFixed(2)} (threshold $${COST_SPIKE_USD}).`,
      latest_error: null, error_signature: 'cost_spike', cls: { recoverable: false, level: 3, category: 'cost' }, stats: {} });
  }

  summary.detected = detected.length;

  for (const d of detected) {
    if (d.cls && d.cls.level === 0) continue; // by-design caps — not a fault

    // Decide (read-only) before touching anything, so dry-run can preview.
    const existing = await findOpenIncident(db, d.agent, d.issue_type);
    const attemptCount = existing ? existing.attempt_count : 0;
    const lastAttemptAt = existing ? existing.last_attempt_at : null;
    const cdOk = !lastAttemptAt || (Date.now() - new Date(lastAttemptAt).getTime() >= COOLDOWN_MS);
    const recoverable = !!(d.cls && d.cls.recoverable);
    const safeAgent = SAFE_TO_REQUEUE.has(d.agent);
    const budgetLeft = attemptCount < MAX_ATTEMPTS;
    const canAuto = safeAgent && budgetLeft && cdOk && !costGuardTripped;

    let action, level;
    if (d.issue_type === 'cost_spike') { action = 'escalate'; level = 3; }
    else if (d.issue_type === 'stuck_jobs') { action = canAuto ? 'clear_and_requeue' : 'clear_stuck'; level = canAuto ? 1 : Math.max(2, d.cls ? d.cls.level : 2); }
    else if (recoverable && canAuto) { action = 'requeue'; level = 1; }
    else { action = 'escalate'; level = d.cls ? Math.max(2, d.cls.level) : 2; }

    if (dryRun) {
      plan.push({ agent: d.agent, issue: d.issue_type, severity: d.severity, action, level, impact: d.business_impact, diagnosis: d.cls && d.cls.cause });
      continue;
    }

    const incident = await upsertIncident(db, {
      agent_name: d.agent, issue_type: d.issue_type, severity: d.severity,
      latest_error: (d.latest_error || '').slice(0, 500), error_signature: d.error_signature,
      business_impact: d.business_impact, diagnosis_summary: d.cls ? d.cls.cause : null,
      affected_jobs: d.stuck || (d.stats && d.stats.recent_job_ids) || [],
      links_to_logs: { agent_hub: '/admin/agent-hub' },
    });

    if (d.issue_type === 'cost_spike') {
      await escalate(db, incident, 3, 'AI spend exceeded the daily threshold — review for a runaway loop before it continues.', 'cost spike', 'red');
      summary.escalated++; continue;
    }

    if (d.issue_type === 'stuck_jobs') {
      for (const jid of (d.stuck || [])) {
        await db.from('agent_jobs').update({ status: 'failed', error: 'ops-guardian: timed out (stuck in processing)', completed_at: nowIso() })
          .eq('id', jid).eq('status', 'processing');
      }
      if (action === 'clear_and_requeue') {
        await enqueueJob(FGA_TENANT_ID, d.agent, {});
        await recordRemediation(db, incident, 'cleared_stuck_and_requeued', 1, 'cleared stuck job(s) + requeued one fresh run',
          { status: 'remediating', verification_result: 'pending', attempt_count: incident.attempt_count + 1, last_attempt_at: nowIso() });
        summary.remediated++;
      } else {
        await recordRemediation(db, incident, 'cleared_stuck', 1, 'cleared stuck job(s); a re-run was not auto-applied (not safelisted / guard active)');
        await escalate(db, incident, level, 'stuck job cleared; re-run needs approval', 'stuck jobs', d.severity);
        summary.escalated++;
      }
      continue;
    }

    if (action === 'requeue') {
      await enqueueJob(FGA_TENANT_ID, d.agent, {});
      await recordRemediation(db, incident, 'requeued_run', 1, 'requeued one fresh run; verifying recovery next cycle',
        { status: 'remediating', verification_result: 'pending', attempt_count: incident.attempt_count + 1, last_attempt_at: nowIso() });
      summary.remediated++;
      continue;
    }

    // ── Escalate (Level 2/3) ──
    const reasonBits = [];
    if (!recoverable) reasonBits.push('root cause is not retry-recoverable');
    if (!safeAgent) reasonBits.push('agent sends external messages — a re-run needs approval');
    if (!budgetLeft) reasonBits.push(`auto-retry budget exhausted (${MAX_ATTEMPTS}×)`);
    if (costGuardTripped) reasonBits.push(`cost guard active ($${costToday.toFixed(2)} spent today)`);
    await escalate(db, incident, level, reasonBits.join('; ') || 'needs owner review',
      d.issue_type.replace(/_/g, ' '), d.severity);
    summary.escalated++;
  }

  if (dryRun) summary.plan = plan;
  log.info(`Guardian sweep${dryRun ? ' (dry-run)' : ''}: ${JSON.stringify(summary)}`);
  return summary;
}

/** Open/active incidents for the digest + Agent Hub (newest first). */
async function getOpenIncidents(db, limit = 50) {
  const client = db || getServiceClient();
  const { data } = await client.from('ops_incidents').select('*')
    .in('status', ACTIVE).order('severity', { ascending: true }).order('detected_at', { ascending: false }).limit(limit);
  return data || [];
}

module.exports = { runGuardian, getOpenIncidents, SAFE_TO_REQUEUE };
