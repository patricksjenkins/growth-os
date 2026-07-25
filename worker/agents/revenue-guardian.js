/**
 * Chief Revenue Agent — daily outcome watchdog and bounded self-healer.
 *
 * OWNS: 25 unique first-touch FGA prospect emails per ET business day.
 *
 * WHY IT EXISTS
 * FGA sent 21 emails on 2026-07-23 and zero on the two business days after.
 * A guardrail paused sending, every later run recorded a clean skip, and the
 * owner discovered it by asking. That was the third repetition of one shape:
 * a gate stops the pipeline, the run reports success, nobody is told.
 *
 * This agent measures the OUTCOME rather than the runs, so any cause of zero
 * sends — including causes that do not exist yet — produces the same visible
 * failure with the responsible stage named.
 *
 * SAFETY (deliberate, do not relax without owner approval)
 *   - FGA tenant only. Never touches a client tenant.
 *   - NEVER sends email itself. It re-enqueues the existing, capped sender,
 *     which keeps every gate, cap and identity check in force.
 *   - Bounded: max attempts per condition per day, cooldown between attempts,
 *     idempotency key per (day, condition), and no self-triggering.
 *   - One condition produces ONE incident with updates, never a daily alert.
 *   - Tier-1 remediations only. Anything touching money, suppression policy,
 *     tenant identity, spend, or production config escalates to Patrick.
 */

const { createLogger } = require('../../core/logger');
const { getServiceClient } = require('../../db/client');
const { FGA_TENANT_ID, getConfig } = require('../../core/config');
const {
  DEFAULTS, HEALTH, isUnhealthy, etParts, isBusinessDay,
  expectedByNow, currentCheckpoint, pastDeadline, assessHealth, countFirstTouchSends,
} = require('../../core/revenue/daily-outcome');
const { traceFunnel, primaryBlocker } = require('../../core/revenue/funnel-trace');

const MAX_ATTEMPTS_PER_DAY = 4;
const COOLDOWN_MINUTES = 45;

/** Tier-1 remediations. Each returns {action, ok, detail}. */
const REMEDIATIONS = {
  /** Inventory low -> ask prospecting/enrichment for more. Never sends. */
  async replenish_inventory(db, ctx) {
    const jobs = [
      { agent_name: 'prospecting', payload: { reason: 'revenue_guardian_replenish' } },
      { agent_name: 'enrichment', payload: { reason: 'revenue_guardian_replenish' } },
    ];
    for (const j of jobs) {
      await db.from('agent_jobs').insert({
        tenant_id: FGA_TENANT_ID, agent_name: j.agent_name, payload: j.payload, status: 'pending',
      });
    }
    return { action: 'replenish_inventory', ok: true, detail: 'queued prospecting + enrichment' };
  },

  /** Unscored leads starve the gate -> re-run scoring. */
  async rescore_leads(db) {
    await db.from('agent_jobs').insert({
      tenant_id: FGA_TENANT_ID, agent_name: 'scoring',
      payload: { reason: 'revenue_guardian_rescore' }, status: 'pending',
    });
    return { action: 'rescore_leads', ok: true, detail: 'queued scoring' };
  },

  /** No drafts to evaluate -> ask the drafter for more. */
  async regenerate_drafts(db) {
    await db.from('agent_jobs').insert({
      tenant_id: FGA_TENANT_ID, agent_name: 'outreach',
      payload: { reason: 'revenue_guardian_drafts' }, status: 'pending',
    });
    return { action: 'regenerate_drafts', ok: true, detail: 'queued outreach drafting' };
  },

  /**
   * Suppress hard-bounced addresses so they cannot bounce again, then let the
   * breaker re-evaluate. This is the fix for the incident that started all of
   * this: one stale address should be removed and replaced, not allowed to
   * stop the department.
   */
  async suppress_bounced(db, ctx) {
    const addrs = ctx.capState?.suppressCandidates || [];
    if (!addrs.length) return { action: 'suppress_bounced', ok: false, detail: 'no candidates' };
    let added = 0;
    for (const email of addrs.slice(0, 25)) {
      const { data: existing } = await db.from('lead_suppressions').select('id')
        .eq('tenant_id', FGA_TENANT_ID).eq('email', email).eq('channel', 'email').limit(1);
      if (existing && existing.length) continue;
      const { error } = await db.from('lead_suppressions').insert({
        tenant_id: FGA_TENANT_ID, email, reason: 'hard_bounce', channel: 'email',
        source: 'revenue_guardian', created_by: 'revenue-guardian',
        note: 'Auto-suppressed after a hard bounce so it cannot bounce again.',
      });
      if (!error) added++;
    }
    return { action: 'suppress_bounced', ok: added > 0, detail: `suppressed ${added} address(es)` };
  },

  /**
   * Behind pace with healthy inventory and no blocker -> run the sender again
   * within its own caps. This is the same-day recovery path: it does not
   * bypass a single gate, it just asks the capped sender to work again.
   */
  async run_sender(db) {
    await db.from('agent_jobs').insert({
      tenant_id: FGA_TENANT_ID, agent_name: 'auto-outreach',
      payload: { reason: 'revenue_guardian_recovery' }, status: 'pending',
    });
    return { action: 'run_sender', ok: true, detail: 'queued auto-outreach recovery run' };
  },
};

/** Which Tier-1 remediations apply to a health state, in order. */
function planRemediation(health, trace, capState) {
  switch (health) {
    case HEALTH.DEGRADED_INVENTORY:
      return trace.inventory.scored < trace.inventory.withEmail
        ? ['rescore_leads', 'replenish_inventory']
        : ['regenerate_drafts', 'replenish_inventory'];
    case HEALTH.BLOCKED_DELIVERABILITY:
      // Only actionable when the pause is driven by addresses we can remove.
      return (capState?.suppressCandidates || []).length ? ['suppress_bounced'] : [];
    case HEALTH.BLOCKED_QUALITY:
      return ['regenerate_drafts'];
    case HEALTH.BEHIND_TARGET:
      return ['run_sender'];
    case HEALTH.BLOCKED_CONFIGURATION:
    case HEALTH.BLOCKED_PROVIDER:
      return []; // Tier 2/3 — needs Reliability or Patrick.
    default:
      return [];
  }
}

/** One incident per (day, condition), updated in place. Never a daily spam. */
async function upsertIncident(db, { etDate, health, snapshot, log }) {
  const key = `revenue-outcome:${etDate}:${health}`;
  const { data: existing } = await db.from('attention_queue')
    .select('id, payload')
    .eq('tenant_id', FGA_TENANT_ID)
    .eq('type', 'revenue_outcome')
    .is('resolved_at', null)
    .limit(20);

  const match = (existing || []).find((r) => r.payload?.idempotency_key === key);
  const severity = health === HEALTH.MISSED_DAILY_OUTCOME ||
    health === HEALTH.HUMAN_ACTION_REQUIRED ? 'red' : 'amber';
  const title = health === HEALTH.MISSED_DAILY_OUTCOME
    ? `Revenue: ${snapshot.sentToday}/${snapshot.target} sent — daily outcome MISSED`
    : `Revenue: ${snapshot.sentToday}/${snapshot.target} sent — ${health.replace(/_/g, ' ')}`;
  const summary = [
    snapshot.reason,
    snapshot.primaryBlocker ? `Blocker: ${snapshot.primaryBlocker.detail}` : null,
    snapshot.remediations?.length ? `Remediation: ${snapshot.remediations.map((r) => r.action).join(', ')}` : null,
  ].filter(Boolean).join(' · ');

  if (match) {
    await db.from('attention_queue').update({
      severity, title, summary,
      payload: { ...match.payload, ...snapshot, idempotency_key: key, updated_at: new Date().toISOString() },
    }).eq('id', match.id);
    log.info(`Incident updated (${health})`);
    return { incidentId: match.id, created: false };
  }

  const { data } = await db.from('attention_queue').insert({
    tenant_id: FGA_TENANT_ID, type: 'revenue_outcome', severity, title, summary,
    payload: { ...snapshot, idempotency_key: key },
    quick_actions: [{ label: 'Open Revenue', href: '/admin/growth' }],
    produced_by: 'revenue-guardian',
  }).select('id').single();
  log.warn(`Incident raised (${health}): ${title}`);
  return { incidentId: data?.id || null, created: true };
}

/** Close today's open revenue incidents once the target is met. */
async function resolveIncidents(db, etDate, log) {
  const { data: open } = await db.from('attention_queue')
    .select('id, payload').eq('tenant_id', FGA_TENANT_ID)
    .eq('type', 'revenue_outcome').is('resolved_at', null).limit(50);
  let closed = 0;
  for (const row of open || []) {
    if (!String(row.payload?.idempotency_key || '').includes(etDate)) continue;
    await db.from('attention_queue').update({ resolved_at: new Date().toISOString() }).eq('id', row.id);
    closed++;
  }
  if (closed) log.success(`Target met — closed ${closed} revenue incident(s)`);
  return closed;
}

async function run(tenant, payload = {}) {
  const log = createLogger('revenue-guardian', tenant.slug);

  const isFga = tenant.id === FGA_TENANT_ID || tenant.slug === 'fga';
  if (!isFga) return { success: true, skipped: 'not_fga_tenant', outcome_contract: {
    result_state: 'succeeded', output_state: 'no_op', business_outcome_state: 'not_applicable',
    reason_code: 'fga_only' } };

  if (String(getConfig(tenant, 'revenue_guardian_enabled', 'true')) === 'false') {
    return { success: true, skipped: 'kill_switch', message: 'revenue_guardian_enabled=false',
      outcome_contract: { result_state: 'succeeded', output_state: 'no_op',
        business_outcome_state: 'not_applicable', reason_code: 'kill_switch' } };
  }

  const db = getServiceClient();
  const now = payload.now ? new Date(payload.now) : new Date();
  const target = Number(getConfig(tenant, 'revenue_daily_target', DEFAULTS.dailyTarget)) || DEFAULTS.dailyTarget;
  const { date: etDate } = etParts(now);

  if (!isBusinessDay(now)) {
    return { success: true, etDate, target, sentToday: null, health: HEALTH.NOT_A_BUSINESS_DAY,
      message: 'not a business day', candidates: 0,
      outcome_contract: { result_state: 'succeeded', output_state: 'no_op',
        business_outcome_state: 'not_applicable', reason_code: 'not_a_business_day' } };
  }

  // ── Observe ──────────────────────────────────────────────────────────────
  const [counted, trace] = await Promise.all([
    countFirstTouchSends(db, { date: now }),
    traceFunnel(db, { date: now }),
  ]);
  let capState = null;
  try {
    const { computeCapState } = require('../../core/auto-outreach');
    if (typeof computeCapState === 'function') capState = await computeCapState(db, tenant, now);
  } catch (err) { log.warn(`capState unavailable: ${err.message}`); }

  if (capState?.deliverabilityPaused && !trace.blockers.deliverability) {
    trace.blockers.deliverability = capState.detail;
  }

  const assessed = assessHealth({
    target, sentToday: counted.count, inventory: trace.inventory,
    blockers: trace.blockers, now,
  });
  const blocker = primaryBlocker(trace);
  const checkpoint = currentCheckpoint(now);

  log.info(`Outcome ${counted.count}/${target} · expected ${assessed.expected ?? 0} · ${assessed.health}`);

  // ── Healthy: close anything open and stop ────────────────────────────────
  if (!isUnhealthy(assessed.health)) {
    const closed = counted.count >= target ? await resolveIncidents(db, etDate, log) : 0;
    return {
      success: true, etDate, target, sentToday: counted.count,
      expected: assessed.expected, remaining: assessed.remaining,
      health: assessed.health, reason: assessed.reason,
      inventory: trace.inventory, incidentsClosed: closed, remediations: [],
      outcome_contract: {
        result_state: 'succeeded',
        output_state: counted.count > 0 ? 'produced' : 'no_op',
        business_outcome_state: counted.count >= target ? 'achieved' : 'not_applicable',
        reason_code: assessed.health,
        evidence: { sent: counted.count, target, checkpoint: checkpoint?.label || null },
      },
    };
  }

  // ── Diagnose + bounded remediation ───────────────────────────────────────
  const attemptsKey = `revenue_remediation:${etDate}`;
  const { data: priorAttempts } = await db.from('activity_log')
    .select('id, created_at, metadata')
    .eq('tenant_id', FGA_TENANT_ID).eq('action', 'revenue_remediation')
    .gte('created_at', trace.stages ? counted.window.startIso : counted.window.startIso)
    .lt('created_at', counted.window.endIso).limit(50);
  const attemptCount = (priorAttempts || []).length;
  const lastAttemptAt = (priorAttempts || []).map((r) => r.created_at).sort().pop();
  const cooledDown = !lastAttemptAt ||
    (now.getTime() - new Date(lastAttemptAt).getTime()) >= COOLDOWN_MINUTES * 60000;

  const plan = planRemediation(assessed.health, trace, capState);
  const remediations = [];
  let humanActionRequired = plan.length === 0;

  if (plan.length && attemptCount < MAX_ATTEMPTS_PER_DAY && cooledDown && !payload.observeOnly) {
    for (const name of plan) {
      const fn = REMEDIATIONS[name];
      if (!fn) continue;
      try {
        const res = await fn(db, { trace, capState, target, sentToday: counted.count });
        remediations.push(res);
        log.info(`Remediation ${name}: ${res.detail}`);
      } catch (err) {
        remediations.push({ action: name, ok: false, detail: err.message.slice(0, 120) });
        log.error(`Remediation ${name} failed: ${err.message}`);
      }
    }
    await db.from('activity_log').insert({
      tenant_id: FGA_TENANT_ID, action: 'revenue_remediation', entity_type: 'revenue_outcome',
      metadata: { etDate, health: assessed.health, attempt: attemptCount + 1, remediations,
        sent: counted.count, target },
    }).then(() => {}, () => {});
  } else if (plan.length && attemptCount >= MAX_ATTEMPTS_PER_DAY) {
    humanActionRequired = true;
    log.warn(`Remediation budget exhausted (${attemptCount}/${MAX_ATTEMPTS_PER_DAY})`);
  }

  const finalHealth = humanActionRequired && assessed.health !== HEALTH.MISSED_DAILY_OUTCOME
    ? HEALTH.HUMAN_ACTION_REQUIRED
    : assessed.health;

  // ── Report: one incident per condition, updated ──────────────────────────
  const snapshot = {
    etDate, target, sentToday: counted.count, expected: assessed.expected,
    remaining: assessed.remaining, health: finalHealth, reason: assessed.reason,
    checkpoint: checkpoint?.label || null,
    primaryBlocker: blocker, inventory: trace.inventory,
    blockReasons: trace.blockReasons.slice(0, 6),
    remediations, attempt: attemptCount + (remediations.length ? 1 : 0),
    maxAttempts: MAX_ATTEMPTS_PER_DAY, humanActionRequired,
  };
  const incident = await upsertIncident(db, { etDate, health: finalHealth, snapshot, log });

  return {
    success: true, etDate, target, sentToday: counted.count,
    expected: assessed.expected, remaining: assessed.remaining,
    health: finalHealth, reason: assessed.reason,
    blocker, inventory: trace.inventory, remediations,
    incidentId: incident.incidentId, incidentCreated: incident.created,
    humanActionRequired,
    outcome_contract: {
      result_state: 'succeeded',
      output_state: 'produced',
      business_outcome_state: 'not_achieved',
      reason_code: finalHealth,
      evidence: {
        sent: counted.count, target, expected: assessed.expected,
        blocker: blocker?.class || null,
        remediations_applied: remediations.filter((r) => r.ok).length,
        incident: incident.incidentId || null,
      },
    },
  };
}

module.exports = run;
module.exports.REMEDIATIONS = REMEDIATIONS;
module.exports.planRemediation = planRemediation;
module.exports.MAX_ATTEMPTS_PER_DAY = MAX_ATTEMPTS_PER_DAY;
module.exports.COOLDOWN_MINUTES = COOLDOWN_MINUTES;
