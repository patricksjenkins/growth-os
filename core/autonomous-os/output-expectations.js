'use strict';

/**
 * Idleness classification — the difference between "nothing was due" and
 * "this agent is broken and has been reporting success for weeks".
 *
 * Built 2026-07-24. buildOutcomeEnvelope() could already record that a job
 * completed, but for legacy handlers it returned output_state 'unknown' for
 * every empty run. That made the outcome contract cosmetic: it could not
 * separate the 1,775 correctly-empty scheduled-email-dispatch sweeps from
 * past-customer-reengagement, which returned {sent:0, skipped:0} on 12 of 12
 * runs across its entire life while reporting success:true.
 *
 * The rule, derived from the real result payloads in production:
 *
 *   A run is only defensibly idle if the agent PROVED it looked.
 *
 * Concretely:
 *   productive      work counters > 0
 *   idle_correct    zero work AND eligibility evidence shows nothing was due
 *                   (candidates:0, "No emails due"), OR candidates existed and
 *                   every one is accounted for by a decline reason
 *                   (opted_out, already_requested, nothing_due)
 *   failed_to_act   zero work AND candidates existed AND they are NOT
 *                   accounted for   → publisher {total:2, published:0}
 *   unverifiable    zero work AND no eligibility evidence at all
 *                   → past-customer-reengagement {sent:0, skipped:0}
 *
 * `unverifiable` is not an accusation on one run; a sweeper can be sloppy
 * about reporting. It becomes a DOWN verdict when it repeats — see
 * classifyAgentHistory(), which is what operations-guardian consumes.
 */

// Result keys that represent real work having been produced.
// `checked` counts: for a monitor, probing dependencies IS the work product,
// not a candidate pool. `processed` counts only when numeric — an array of
// processed items is inspected action-by-action further down, because a
// processed[] full of skips is not work.
const WORK_KEYS = [
  'sent', 'published', 'enqueued', 'created', 'created_count', 'delivered',
  'detected', 'remediated', 'recovered', 'matched', 'drafted', 'generated',
  'scored', 'enriched', 'imported', 'posted', 'resolved', 'updated',
  'checked', 'synced', 'reconciled',
];

// Domain-specific work counters observed in production payloads.
const WORK_KEYS_EXTRA = [
  'classified', 'briefings', 'next_actions', 'alerts_raised', 'push_sent',
  'transactions_imported', 'slides', 'images', 'sms_sent', 'reports',
  'interventions', 'receipts', 'closed', 'refreshed', 'moved', 'stale_marked',
  'concepts', 'qualified', 'tenants_reset', 'drafted_fb', 'sent_sms',
  'alerted', 'captured', 'swept_count', 'tenants_scored',
];

// Result keys that prove the agent evaluated a population, even if it acted
// on none of it.
const ELIGIBILITY_KEYS = ['candidates', 'total', 'evaluated', 'considered', 'eligible', 'pending'];

// Keys that count deliberate declines. Non-zero means "looked and said no".
const DECLINE_KEYS = [
  'skipped', 'held', 'suppressed', 'blocked', 'needs_review', 'filtered',
  'transactions_skipped_dup', 'duplicates',
];

// Keys whose presence with substantive content means an artifact was produced
// (a report, a dashboard, a snapshot, a draft). A monitor that computes an
// assessment has done its job even when the assessment is "all clear".
const ARTIFACT_KEYS = [
  'dashboard', 'report', 'snapshot', 'draft_id', 'briefing', 'signals',
  'email_result', 'summary', 'digest', 'revenue', 'reliability', 'score',
  'cash_balance', 'snapshot_written', 'coordination', 'plan_id', 'breakdown',
  'accounts', 'tenants', 'at_risk', 'reply', 'classification',
  'voice_call_sid', 'current_month', 'by_status', 'queue_sync',
];

// Keys that hold a findings list. Presence — even empty — proves the agent
// ran its evaluation. `{alerts: []}` means "checked, nothing to report".
const FINDINGS_ARRAY_KEYS = ['alerts', 'reasons', 'down', 'degraded', 'errors', 'results',
  'findings', 'incidents', 'summary', 'issues', 'duplicates', 'hot_leads', 'at_risk', 'accounts'];

// Messages/reasons that themselves prove an empty queue was checked.
// Broad on purpose: agents phrase this many ways ("No emails due",
// "No unclassified replies", "No meetings to prep").
const EMPTY_QUEUE_PATTERNS = [
  /^\s*no\s+\S+/i,
  /nothing (due|to do|pending|found)/i,
  /queue (is )?empty/i,
  /none (due|pending|found|eligible)/i,
];

const VERDICTS = Object.freeze({
  PRODUCTIVE: 'productive',
  IDLE_CORRECT: 'idle_correct',
  FAILED_TO_ACT: 'failed_to_act',
  UNVERIFIABLE: 'unverifiable',
  ERROR: 'error',
  SKIPPED_FOR_CAUSE: 'skipped_for_cause',
});

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Did the run produce a substantive artifact (report, dashboard, draft)? */
function producedArtifact(result) {
  if (!result || typeof result !== 'object') return false;
  for (const k of ARTIFACT_KEYS) {
    const v = result[k];
    if (v === undefined || v === null) continue;
    if (v === true) return true;
    if (typeof v === 'number' && Number.isFinite(v)) return true;
    if (typeof v === 'string' && v.trim().length > 0) return true;
    if (Array.isArray(v)) { if (v.length > 0) return true; continue; }
    if (typeof v === 'object' && Object.keys(v).length > 0) return true;
  }
  // A nested provider result that reports a delivered send.
  const er = result.email_result;
  if (er && typeof er === 'object' && /sent|delivered|queued/i.test(String(er.status || ''))) return true;
  return false;
}

/** Sum numeric work counters, including one level of nested result arrays. */
function countWork(result) {
  if (!result || typeof result !== 'object') return 0;
  let work = 0;
  for (const k of [...WORK_KEYS, ...WORK_KEYS_EXTRA]) if (k in result) work += num(result[k]);
  // `processed: 18` (a count) is work; `processed: [...]` is judged by action.
  if (typeof result.processed === 'number') work += num(result.processed);
  // Booleans that assert an artifact was written.
  if (result.snapshot_written === true) work += 1;
  if (result.email_sent === true) work += 1;
  // Nested coordination counters (prospecting-orchestrator).
  if (result.coordination && typeof result.coordination === 'object') {
    for (const k of ['updated', 'cleared', 'superseded', 'examined']) {
      if (k in result.coordination) work += num(result.coordination[k]);
    }
  }
  // Agents that report per-mode sub-results (facebook-prospecting emits
  // day0/day7/post7, each with its own counters). Recurse one level so
  // `{day0:{drafted_fb:3}}` is recognised as work rather than emptiness.
  for (const [key, sub] of Object.entries(result)) {
    if (!sub || typeof sub !== 'object' || Array.isArray(sub)) continue;
    if (key === 'coordination') continue;
    for (const k of [...WORK_KEYS, ...WORK_KEYS_EXTRA]) {
      if (k in sub) work += num(sub[k]);
    }
  }
  // Agents that fan out per handler (sales-nurture) nest their counters.
  if (Array.isArray(result.results)) {
    for (const r of result.results) if (r && typeof r === 'object') {
      for (const k of WORK_KEYS) if (k in r) work += num(r[k]);
    }
  }
  // A processed array with entries that actually did something.
  //
  // Agents annotate EXCEPTIONS, not successes: `outreach` emits
  // {company, lead_id, sequence_ids} for a drafted email and only sets
  // `action` when it skips. An earlier version required a non-empty action,
  // so 215 real drafts read as zero work and a healthy agent was called DOWN.
  // Default to counting an entry as work unless it declares a decline or an
  // error.
  if (Array.isArray(result.processed)) {
    work += result.processed.filter((p) => {
      if (!p || typeof p !== 'object') return false;
      if (p.error) return false;
      const t = `${p.action || ''} ${p.reason || ''}`.toLowerCase();
      if (!t.trim()) return true; // unannotated = completed normally
      return !/skip|already|opted_out|nothing|duplicate|no_channel|declin|suppress|not_due|no_email|fail|error/.test(t);
    }).length;
  }
  return work;
}

/** Did the agent demonstrate that it examined a population? */
function eligibilityEvidence(result) {
  if (!result || typeof result !== 'object') {
    return { proved: false, candidates: 0, declines: 0, emptyQueueSignal: false };
  }
  let candidates = 0;
  let sawKey = false;
  for (const k of ELIGIBILITY_KEYS) {
    if (k in result) { candidates += num(result[k]); sawKey = true; }
  }
  let declines = 0;
  for (const k of DECLINE_KEYS) if (k in result) declines += num(result[k]);
  if (Array.isArray(result.processed)) {
    candidates = Math.max(candidates, result.processed.length);
    // An entry whose action/reason is itself a decline is accounted for.
    declines += result.processed.filter((p) => {
      const t = `${p?.action || ''} ${p?.reason || ''}`.toLowerCase();
      return /skip|already|opted_out|nothing|duplicate|no_channel|declin|suppress|not_due|no_email/.test(t);
    }).length;
  }
  if (Array.isArray(result.results)) {
    for (const r of result.results) if (r && typeof r === 'object') {
      for (const k of DECLINE_KEYS) if (k in r) declines += num(r[k]);
    }
  }
  // A findings key — even an empty array — proves the evaluation ran.
  let findingsKeyPresent = false;
  for (const k of FINDINGS_ARRAY_KEYS) if (Array.isArray(result[k])) findingsKeyPresent = true;

  const text = `${result.message || ''} ${result.reason || ''} ${result.skipped_reason || ''}`;
  const emptyQueueSignal = EMPTY_QUEUE_PATTERNS.some((re) => re.test(text.trim()));
  return {
    proved: sawKey || declines > 0 || emptyQueueSignal || findingsKeyPresent ||
      Array.isArray(result.processed),
    candidates,
    declines,
    emptyQueueSignal,
    findingsKeyPresent,
  };
}

/**
 * Classify one run. Pure — no database, no clock.
 * Returns { verdict, work, candidates, declines, why }.
 */
function classifyRun({ result, status, error } = {}) {
  if (error || status === 'failed') {
    return { verdict: VERDICTS.ERROR, work: 0, candidates: 0, declines: 0,
      why: 'execution failed' };
  }
  if (result && typeof result === 'object' && result.success === false) {
    return { verdict: VERDICTS.ERROR, work: 0, candidates: 0, declines: 0,
      why: 'handler returned success:false' };
  }
  // A handler that returns only an error string failed, even without throwing.
  if (result && typeof result === 'object' && typeof result.error === 'string' && result.error.trim()) {
    return { verdict: VERDICTS.ERROR, work: 0, candidates: 0, declines: 0,
      why: `returned error: ${result.error.slice(0, 60)}` };
  }

  const work = countWork(result);
  const ev = eligibilityEvidence(result);
  const base = { work, candidates: ev.candidates, declines: ev.declines };

  if (work > 0) return { ...base, verdict: VERDICTS.PRODUCTIVE, why: `produced ${work}` };
  if (producedArtifact(result)) {
    return { ...base, verdict: VERDICTS.PRODUCTIVE, why: 'produced a report/assessment artifact' };
  }

  // Explicit, reasoned skip (deliverability pause, kill switch, wrong tenant
  // class) is a decision, not idleness. `skipped` may be boolean OR a reason
  // string — digest returns {skipped:'platform_tenant'}.
  const skipVal = result && typeof result === 'object' ? result.skipped : undefined;
  const skipIsFlag = skipVal === true || result?.no_op === true;
  const skipIsReason = typeof skipVal === 'string' && skipVal.trim().length > 0;
  if (skipIsReason) {
    return { ...base, verdict: VERDICTS.SKIPPED_FOR_CAUSE,
      why: `skipped: ${skipVal.slice(0, 60)}` };
  }
  if (skipIsFlag && (result.reason || result.skipped_reason)) {
    return { ...base, verdict: VERDICTS.SKIPPED_FOR_CAUSE,
      why: `skipped: ${String(result.reason || result.skipped_reason).slice(0, 60)}` };
  }

  if (ev.emptyQueueSignal && ev.candidates === 0) {
    return { ...base, verdict: VERDICTS.IDLE_CORRECT, why: 'empty queue, stated' };
  }
  if (ev.proved && ev.candidates === 0 && ev.declines === 0) {
    return { ...base, verdict: VERDICTS.IDLE_CORRECT,
      why: ev.findingsKeyPresent ? 'evaluation ran, nothing to report' : 'evaluated 0 candidates' };
  }
  if (ev.candidates > 0 && ev.declines >= ev.candidates) {
    return { ...base, verdict: VERDICTS.IDLE_CORRECT,
      why: `${ev.candidates} candidates, all declined for cause` };
  }
  if (ev.candidates > 0) {
    return { ...base, verdict: VERDICTS.FAILED_TO_ACT,
      why: `${ev.candidates} available, ${work} acted on, ${ev.declines} accounted for` };
  }
  if (ev.declines > 0) {
    return { ...base, verdict: VERDICTS.IDLE_CORRECT, why: `${ev.declines} declined for cause` };
  }
  return { ...base, verdict: VERDICTS.UNVERIFIABLE,
    why: 'zero output and no evidence the agent evaluated anything' };
}

/** Consecutive unverifiable/failed runs before an agent is called DOWN. */
const DOWN_THRESHOLD = 3;

/**
 * Roll a run history (newest first) into a health verdict.
 * Returns { health, verdict_counts, consecutive_bad, reason }.
 *   healthy    at least one productive run in the window
 *   idle_ok    no work, but every empty run was defensibly idle
 *   down       DOWN_THRESHOLD+ consecutive unverifiable / failed_to_act runs
 *   degraded   a mix that includes failures but not enough to call it down
 */
function classifyAgentHistory(runs = [], { downThreshold = DOWN_THRESHOLD } = {}) {
  const counts = {};
  let consecutiveBad = 0;
  let brokeStreak = false;
  let productive = 0;

  for (const r of runs) {
    const c = classifyRun(r);
    counts[c.verdict] = (counts[c.verdict] || 0) + 1;
    if (c.verdict === VERDICTS.PRODUCTIVE) productive++;
    const bad = c.verdict === VERDICTS.UNVERIFIABLE || c.verdict === VERDICTS.FAILED_TO_ACT ||
      c.verdict === VERDICTS.ERROR;
    if (!brokeStreak) {
      if (bad) consecutiveBad++;
      else brokeStreak = true;
    }
  }

  const totalBad = (counts[VERDICTS.UNVERIFIABLE] || 0) + (counts[VERDICTS.FAILED_TO_ACT] || 0) +
    (counts[VERDICTS.ERROR] || 0);

  let health = 'idle_ok';
  let reason = 'no work produced, but every empty run was defensibly idle';
  if (consecutiveBad >= downThreshold) {
    health = 'down';
    reason = `${consecutiveBad} consecutive runs produced nothing with no evidence of work available`;
  } else if (productive > 0 && totalBad === 0) {
    health = 'healthy';
    reason = `${productive} of ${runs.length} runs produced output`;
  } else if (productive > 0) {
    health = 'degraded';
    reason = `${productive} productive but ${totalBad} unverified/failed in window`;
  } else if (totalBad > 0) {
    health = 'degraded';
    reason = `${totalBad} unverified/failed runs, none productive`;
  }

  return { health, verdict_counts: counts, consecutive_bad: consecutiveBad,
    productive_runs: productive, window: runs.length, reason };
}

/** Map a run verdict onto outcome-contract output/business states. */
function verdictToOutcomeStates(verdict) {
  switch (verdict) {
    case VERDICTS.PRODUCTIVE: return { output_state: 'produced', business_outcome_state: 'achieved' };
    case VERDICTS.IDLE_CORRECT: return { output_state: 'no_op', business_outcome_state: 'not_applicable' };
    case VERDICTS.SKIPPED_FOR_CAUSE: return { output_state: 'no_op', business_outcome_state: 'not_applicable' };
    case VERDICTS.FAILED_TO_ACT: return { output_state: 'no_output', business_outcome_state: 'not_achieved' };
    case VERDICTS.ERROR: return { output_state: 'no_output', business_outcome_state: 'not_achieved' };
    default: return { output_state: 'unknown', business_outcome_state: 'unverified' };
  }
}

module.exports = {
  VERDICTS,
  WORK_KEYS,
  WORK_KEYS_EXTRA,
  ARTIFACT_KEYS,
  producedArtifact,
  ELIGIBILITY_KEYS,
  DECLINE_KEYS,
  DOWN_THRESHOLD,
  countWork,
  eligibilityEvidence,
  classifyRun,
  classifyAgentHistory,
  verdictToOutcomeStates,
};
