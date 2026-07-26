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
const { openHandoff, verifyHandoffs } = require('../../core/revenue/reliability-handoff');

const MAX_ATTEMPTS_PER_DAY = 4;
const COOLDOWN_MINUTES = 45;

/**
 * Queue one agent job and REPORT WHAT ACTUALLY HAPPENED.
 *
 * The first version of this file discarded the insert result and returned
 * ok:true unconditionally. A failed insert produced "queued auto-outreach
 * recovery run" — a remediation that reported success while queueing nothing.
 * That is the same false-green this department was rebuilt to eliminate, so
 * every queue path goes through here and every caller propagates the verdict.
 */
async function queueJob(db, agentName, reason) {
  const { data, error } = await db.from('agent_jobs')
    .insert({
      tenant_id: FGA_TENANT_ID, agent_name: agentName,
      payload: { reason }, status: 'pending',
    })
    .select('id');
  if (error) return { ok: false, agent: agentName, detail: `${agentName}: ${error.message}` };
  if (!data || !data.length) {
    return { ok: false, agent: agentName, detail: `${agentName}: insert returned no row` };
  }
  return { ok: true, agent: agentName, id: data[0].id, detail: `queued ${agentName}` };
}

/**
 * Every agent the guardian may enqueue, as data.
 *
 * Declared here rather than left inline so the registry test can assert all of
 * them are runnable without pattern-matching source code. revenue-guardian is
 * deliberately absent: self-enqueue would be an uncontrolled loop.
 */
const REMEDIATION_TARGETS = Object.freeze({
  replenish_inventory: ['prospecting', 'enrichment'],
  rescore_leads: ['scoring'],
  regenerate_drafts: ['outreach'],
  run_sender: ['auto-outreach'],
  suppress_bounced: [],
});

/** Tier-1 remediations. Each returns {action, ok, detail}. */
const REMEDIATIONS = {
  /** Inventory low -> ask prospecting/enrichment for more. Never sends. */
  async replenish_inventory(db) {
    const results = [];
    for (const agent of REMEDIATION_TARGETS.replenish_inventory) {
      results.push(await queueJob(db, agent, 'revenue_guardian_replenish'));
    }
    const failed = results.filter((r) => !r.ok);
    return {
      action: 'replenish_inventory',
      // Partial success is not success: if either half of the replenish did
      // not queue, the inventory problem is not being worked.
      ok: failed.length === 0,
      detail: failed.length
        ? `failed: ${failed.map((f) => f.detail).join('; ')}`
        : 'queued prospecting + enrichment',
    };
  },

  /** Unscored leads starve the gate -> re-run scoring. */
  async rescore_leads(db) {
    const r = await queueJob(db, 'scoring', 'revenue_guardian_rescore');
    return { action: 'rescore_leads', ok: r.ok, detail: r.detail };
  },

  /** No drafts to evaluate -> ask the drafter for more. */
  async regenerate_drafts(db) {
    const r = await queueJob(db, 'outreach', 'revenue_guardian_drafts');
    return { action: 'regenerate_drafts', ok: r.ok, detail: r.detail };
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
    const r = await queueJob(db, 'auto-outreach', 'revenue_guardian_recovery');
    return {
      action: 'run_sender',
      ok: r.ok,
      detail: r.ok ? 'queued auto-outreach recovery run' : r.detail,
    };
  },
};

/** Which Tier-1 remediations apply to a health state, in order. */
function planRemediation(health, trace, capState) {
  /*
   * SEND-READY INVENTORY OUTRANKS THE HISTORICAL DIAGNOSIS.
   *
   * On 2026-07-26 the drafter produced 25 fresh, gate-eligible drafts at
   * 4:44pm. The guardian classified the day `blocked_quality` — a true
   * statement about drafts scored EARLIER — and its remediation was
   * 'regenerate_drafts', so it made more drafts nobody would send. After 5pm
   * the state became `missed_daily_outcome`, which had no remediation at all.
   * The one action that would have converted inventory into sends was never
   * chosen, at any hour.
   *
   * The stale-vs-actionable distinction: a block recorded against drafts that
   * have since been superseded describes the past. Drafts sitting send-ready
   * right now describe the present. If sendable inventory exists and we are
   * under target, running the sender is the actionable step regardless of what
   * earlier drafts scored — so it is checked FIRST, before the health switch.
   *
   * This cannot over-send: the sender re-runs every gate and the daily cap.
   */
  // `sendReady` is now ACTIONABLE drafts only (core/revenue/actionable-drafts.js):
  // a quality-rejected draft carries a cached verdict, so re-running the sender
  // re-reads the same failing score. Counting those as ready made the rule
  // below queue senders that could not convert anything.
  const sendReady = Number(trace?.inventory?.sendReady || 0);
  const qualityFailed = Number(trace?.inventory?.draftsQualityFailed || 0);
  const canStillSend = (capState?.dailyRemaining ?? 1) > 0 && !capState?.deliverabilityPaused;
  const hardBlocked = health === HEALTH.BLOCKED_DELIVERABILITY
    || health === HEALTH.BLOCKED_CONFIGURATION || health === HEALTH.BLOCKED_PROVIDER;

  if (sendReady > 0 && canStillSend && !hardBlocked) {
    // Drafts exist and can legally go out — send them, then top up inventory.
    return health === HEALTH.DEGRADED_INVENTORY
      ? ['run_sender', 'replenish_inventory']
      : ['run_sender'];
  }
  /*
   * Nothing actionable, but drafts exist that FAILED quality. Those need
   * REPLACING, not resending — the distinction the old sendReady count could
   * not express. Regenerating writes new drafts for the same leads, which the
   * reviewer scores fresh.
   */
  if (sendReady === 0 && qualityFailed > 0 && canStillSend && !hardBlocked) {
    return ['regenerate_drafts'];
  }

  switch (health) {
    case HEALTH.DEGRADED_INVENTORY:
      return trace.inventory.scored < trace.inventory.withEmail
        ? ['rescore_leads', 'replenish_inventory']
        : ['regenerate_drafts', 'replenish_inventory'];
    case HEALTH.BLOCKED_DELIVERABILITY:
      // Only actionable when the pause is driven by addresses we can remove.
      return (capState?.suppressCandidates || []).length ? ['suppress_bounced'] : [];
    case HEALTH.BLOCKED_QUALITY: {
      /*
       * `score_threshold` is LEAD QUALIFICATION (the lead scored below the
       * bar); `draft_quality` is the written email. They were both classed
       * 'quality', so a scoring problem re-ran the drafter — generating new
       * emails for the same unqualified leads, which failed the same way. The
       * remediation has to match which of the two is actually blocking.
       */
      const reasons = trace?.blockReasons || [];
      const worst = reasons.slice().sort((a, b) => b.count - a.count)[0];
      if (worst && worst.reason === 'score_threshold') {
        return ['rescore_leads', 'replenish_inventory'];
      }
      return ['regenerate_drafts'];
    }
    case HEALTH.BEHIND_TARGET:
      // Reached when nothing is send-ready (the guard above covers the case
      // where drafts exist) OR when a cap/breaker blocks sending. Queueing a
      // sender that the cap will immediately refuse burns an attempt from the
      // daily budget and reports a remediation that cannot help.
      if (!canStillSend) return [];
      return ['run_sender'];
    case HEALTH.MISSED_DAILY_OUTCOME:
      // Reached only when nothing is send-ready (the guard above handles the
      // case where drafts exist). Inventory is the constraint for tomorrow.
      return ['replenish_inventory'];
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
  // The first stage that loses volume — this is what names the owning agent on
  // a Tier-2 handoff, so reliability gets "outreach is not drafting" rather
  // than "revenue is down".
  const blockedStage = (trace.stages || []).find((s) => s.blocked > 0) || null;

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

    // A plan that ran but landed nothing is NOT a handled condition. If every
    // remediation reported failure the guardian cannot even queue recovery
    // work, which is an infrastructure fault it must not paper over.
    if (remediations.length && remediations.every((r) => !r.ok)) {
      humanActionRequired = true;
      log.error(`All ${remediations.length} remediation(s) failed — escalating`);
    }
  } else if (plan.length && attemptCount >= MAX_ATTEMPTS_PER_DAY) {
    humanActionRequired = true;
    log.warn(`Remediation budget exhausted (${attemptCount}/${MAX_ATTEMPTS_PER_DAY})`);
  }

  // ── Tier 2: hand off what revenue must not fix itself ────────────────────
  //
  // Configuration and provider faults, an infrastructure failure that stopped
  // remediation queueing, and a funnel whose own numbers disagree are all
  // reliability work. Previously these produced an empty plan and nothing
  // else, so the "escalation" reached no one. Now each opens a structured,
  // idempotent request on the ops_incidents ledger the Operations Guardian and
  // Agent Hub already read, and stays open until sends actually resume.
  const handoffs = [];
  const tier2 = [];
  if (blocker && (blocker.class === 'configuration' || blocker.class === 'provider')) {
    tier2.push({ blockerClass: blocker.class, diagnosis: blocker.detail });
  }
  if (remediations.length && remediations.every((r) => !r.ok)) {
    tier2.push({
      blockerClass: 'remediation_failed',
      diagnosis: remediations.map((r) => `${r.action}: ${r.detail}`).join(' | ').slice(0, 500),
    });
  }
  if (trace.anomalies && trace.anomalies.length) {
    tier2.push({
      blockerClass: 'data_integrity',
      diagnosis: trace.anomalies.map((a) => `${a.stage} ${a.detail}`).join(' | ').slice(0, 500),
    });
  }

  for (const t of tier2) {
    const res = await openHandoff(db, {
      blockerClass: t.blockerClass,
      owningAgent: blockedStage?.agent?.split(' / ')[0] || 'auto-outreach',
      diagnosis: t.diagnosis,
      businessImpact: `${counted.count}/${target} first-touch emails sent on ${etDate}.`,
      evidence: {
        dashboard: '/admin (Revenue Outcome)',
        et_date: etDate,
        checkpoint: checkpoint?.label || null,
        blocked_stage: blockedStage?.id || null,
      },
    });
    handoffs.push({ class: t.blockerClass, ...res });
    if (!res.ok) log.error(`Tier-2 handoff (${t.blockerClass}) failed: ${res.detail}`);
    else log.warn(`Tier-2 handoff (${t.blockerClass}): ${res.detail}`);
  }
  // A Tier-2 condition is not something the owner can ignore.
  if (tier2.length) humanActionRequired = true;

  // Control return: close handoffs only when delivered email proves recovery.
  const verification = await verifyHandoffs(db, { sendsResumed: counted.count >= target });

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
module.exports.REMEDIATION_TARGETS = REMEDIATION_TARGETS;
module.exports.planRemediation = planRemediation;
module.exports.MAX_ATTEMPTS_PER_DAY = MAX_ATTEMPTS_PER_DAY;
module.exports.COOLDOWN_MINUTES = COOLDOWN_MINUTES;
