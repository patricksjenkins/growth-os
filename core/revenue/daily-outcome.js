'use strict';

/**
 * The Revenue Department's daily business invariant.
 *
 * GOAL (CEO-set): 25 unique, qualified FGA prospects receive a first-touch
 * outreach email every business day, America/New_York.
 *
 * WHY THIS MODULE EXISTS
 * Every prior outage had the same shape: a guard, query, config, or cap
 * stopped sending; the run recorded success or a clean skip; and nobody was
 * told. Sending was repaired three times and each repair was measured by
 * "did the agent run", never by "did 25 emails go out". This module makes the
 * OUTCOME the measured thing, so any cause of zero sends — including causes
 * that do not exist yet — produces the same visible failure.
 *
 * COUNTING RULES (deliberately strict — this is the number the business is
 * judged on, so everything that is not a real first touch is excluded):
 *   counts    provider-accepted first-touch sends to distinct prospects
 *   excludes  drafts, queued jobs, skipped records, retries of the same
 *             prospect, drip follow-ups, replies, test sends, client-tenant
 *             sends, and demo-tenant data
 *
 * The source of truth is activity_log action='outreach_sent', which is written
 * at the single send choke point (core/outreach-send.js) for every send path —
 * autonomous, manual approve, bulk, and recovery. Uniqueness is enforced on
 * entity_id (the lead), so three retries against one prospect count once.
 */

const FGA_TENANT_ID = '30566ed6-026a-45e1-9502-029e6219df31';
const ET = 'America/New_York';

const DEFAULTS = Object.freeze({
  dailyTarget: 25,
  // Patrick's directive 2026-07-26: outreach goes out EVERY day, not just
  // Mon-Fri. The mechanism stays configurable (a future tenant may want
  // weekdays only) but FGA's default is all seven ISO weekdays.
  businessDays: [1, 2, 3, 4, 5, 6, 7],
  // Checkpoints as [hourET, minuteET, expectedFractionOfTarget, label].
  // Pace fractions are cumulative expectations, not caps.
  checkpoints: [
    [8, 0, 0.0, 'inventory_ready'],
    [10, 30, 0.2, 'early_progress'],
    [13, 30, 0.5, 'midday_half'],
    [15, 30, 0.8, 'late_progress'],
    [17, 0, 1.0, 'daily_outcome'],
  ],
  deadlineHourET: 17,
  // Inventory floors, expressed as multiples of the daily target.
  inventoryFloors: { sendReady: 1.0, qualified: 3.0, verifiedEmail: 2.0 },
});

/** Health states. Never "healthy because a run skipped cleanly". */
const HEALTH = Object.freeze({
  HEALTHY_ON_TARGET: 'healthy_on_target',
  HEALTHY_IN_PROGRESS: 'healthy_in_progress',
  BEHIND_TARGET: 'behind_target',
  DEGRADED_INVENTORY: 'degraded_inventory',
  BLOCKED_DELIVERABILITY: 'blocked_deliverability',
  BLOCKED_CONFIGURATION: 'blocked_configuration',
  BLOCKED_QUALITY: 'blocked_quality',
  BLOCKED_PROVIDER: 'blocked_provider',
  REMEDIATION_RUNNING: 'remediation_running',
  HUMAN_ACTION_REQUIRED: 'human_action_required',
  MISSED_DAILY_OUTCOME: 'missed_daily_outcome',
  NOT_A_BUSINESS_DAY: 'not_a_business_day',
});

/** Parts of `date` in ET, without pulling in a tz library. */
function etParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: ET, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  });
  const p = {};
  for (const { type, value } of fmt.formatToParts(date)) p[type] = value;
  const isoDay = { Sun: 7, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    isoWeekday: isoDay,
    minutesSinceMidnight: (Number(p.hour) % 24) * 60 + Number(p.minute),
  };
}

/** UTC ISO bounds of an ET calendar day. */
function etDayRangeIso(etDate) {
  const probe = new Date(`${etDate}T12:00:00Z`);
  const etHour = Number(new Intl.DateTimeFormat('en-US',
    { timeZone: ET, hour: 'numeric', hour12: false }).format(probe));
  const offset = 12 - etHour; // 4 during EDT, 5 during EST
  const start = new Date(`${etDate}T00:00:00Z`);
  start.setUTCHours(start.getUTCHours() + offset);
  const end = new Date(start.getTime() + 86400000);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

function isBusinessDay(date = new Date(), cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  return c.businessDays.includes(etParts(date).isoWeekday);
}

/**
 * Expected cumulative sends by now, from the checkpoint curve.
 * Before the first checkpoint the expectation is 0 — the department is not
 * "behind" at 6am, and nothing at all is expected on a non-business day.
 * Without the business-day guard the dashboard reported "0 of 13 expected" on
 * a Saturday, which reads as a failure when the department is correctly idle.
 */
function expectedByNow(target, date = new Date(), cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  if (!isBusinessDay(date, c)) return 0;
  const { minutesSinceMidnight } = etParts(date);
  let fraction = 0;
  for (const [h, m, frac] of c.checkpoints) {
    if (minutesSinceMidnight >= h * 60 + m) fraction = Math.max(fraction, frac);
  }
  return Math.round(target * fraction);
}

/** The checkpoint currently in force, if any. */
function currentCheckpoint(date = new Date(), cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const { minutesSinceMidnight } = etParts(date);
  let cur = null;
  for (const [h, m, frac, label] of c.checkpoints) {
    if (minutesSinceMidnight >= h * 60 + m) cur = { hour: h, minute: m, fraction: frac, label };
  }
  return cur;
}

function pastDeadline(date = new Date(), cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  return etParts(date).hour >= c.deadlineHourET;
}

/**
 * Decide the department's health from measured facts.
 *
 * Pure. `blockers` is the funnel's verdict (see funnel-trace.js) and is what
 * turns a bare "behind" into a specific, actionable state.
 */
function assessHealth({
  target, sentToday, inventory = {}, blockers = {}, remediationRunning = false,
  humanActionRequired = false, now = new Date(), cfg = {},
} = {}) {
  const c = { ...DEFAULTS, ...cfg };
  if (!isBusinessDay(now, c)) {
    return { health: HEALTH.NOT_A_BUSINESS_DAY, reason: 'not a configured outreach business day' };
  }
  const expected = expectedByNow(target, now, c);
  const remaining = Math.max(0, target - sentToday);
  const onPace = sentToday >= expected;

  if (sentToday >= target) {
    return { health: HEALTH.HEALTHY_ON_TARGET, reason: `${sentToday}/${target} sent`, expected, remaining: 0, onPace: true };
  }
  if (humanActionRequired) {
    return { health: HEALTH.HUMAN_ACTION_REQUIRED, reason: 'safe remediation exhausted — owner decision needed', expected, remaining, onPace };
  }
  if (pastDeadline(now, c)) {
    return { health: HEALTH.MISSED_DAILY_OUTCOME, reason: `${sentToday}/${target} at deadline`, expected, remaining, onPace: false };
  }
  if (remediationRunning) {
    return { health: HEALTH.REMEDIATION_RUNNING, reason: 'self-healing in progress', expected, remaining, onPace };
  }
  // A specific blocker outranks a generic "behind".
  if (blockers.deliverability) return { health: HEALTH.BLOCKED_DELIVERABILITY, reason: blockers.deliverability, expected, remaining, onPace };
  if (blockers.configuration) return { health: HEALTH.BLOCKED_CONFIGURATION, reason: blockers.configuration, expected, remaining, onPace };
  if (blockers.provider) return { health: HEALTH.BLOCKED_PROVIDER, reason: blockers.provider, expected, remaining, onPace };
  if (blockers.quality) return { health: HEALTH.BLOCKED_QUALITY, reason: blockers.quality, expected, remaining, onPace };

  const sendReadyFloor = Math.ceil(target * c.inventoryFloors.sendReady);
  if ((inventory.sendReady ?? 0) < Math.min(remaining, sendReadyFloor)) {
    return {
      health: HEALTH.DEGRADED_INVENTORY,
      reason: `${inventory.sendReady ?? 0} send-ready vs ${remaining} still needed today`,
      expected, remaining, onPace,
    };
  }
  if (!onPace) {
    return { health: HEALTH.BEHIND_TARGET, reason: `${sentToday}/${expected} expected by now`, expected, remaining, onPace: false };
  }
  return { health: HEALTH.HEALTHY_IN_PROGRESS, reason: `${sentToday}/${target}, on pace`, expected, remaining, onPace: true };
}

/** States that mean the invariant is currently violated. */
const UNHEALTHY = new Set([
  HEALTH.BEHIND_TARGET, HEALTH.DEGRADED_INVENTORY, HEALTH.BLOCKED_DELIVERABILITY,
  HEALTH.BLOCKED_CONFIGURATION, HEALTH.BLOCKED_QUALITY, HEALTH.BLOCKED_PROVIDER,
  HEALTH.HUMAN_ACTION_REQUIRED, HEALTH.MISSED_DAILY_OUTCOME,
]);
const isUnhealthy = (health) => UNHEALTHY.has(health);

/**
 * The most recent business day that has already finished.
 *
 * Morning reporting needs this. A 6:30am digest that counts TODAY reports 0/25
 * every single day — before the 8:00 checkpoint, before the sender has run —
 * which is both alarming and meaningless. The completed result the owner
 * actually wants is yesterday's (or Friday's, on a Monday).
 */
function lastCompletedBusinessDay(date = new Date(), cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  let probe = new Date(date.getTime());
  // Past the deadline on a business day, today is itself complete.
  if (isBusinessDay(probe, c) && pastDeadline(probe, c)) return probe;
  for (let i = 0; i < 10; i++) {
    probe = new Date(probe.getTime() - 86400000);
    if (isBusinessDay(probe, c)) return probe;
  }
  return probe;
}

/**
 * The configured daily target, read the ONE correct way.
 *
 * Three call sites (the API, the Chief of Staff, the platform digest) each
 * re-implemented this by calling resolveTenant(tenantId) — but resolveTenant's
 * signature is (supabase, tenantId), so every call threw `supabase.from is not
 * a function`, the catch swallowed it, and all three silently reported 25
 * forever regardless of configuration. One helper, direct read, unit-testable.
 */
/**
 * @returns {{target:number, source:'config'|'default'|'error_fallback'}}
 *
 * `source` distinguishes "the target is 25 because nothing else is configured"
 * (fine) from "the target is 25 because the config read FAILED" (not fine —
 * a configured 40 would be silently ignored). Callers surface error_fallback
 * as an unverified target rather than presenting the default as truth.
 */
async function readDailyTarget(db, { tenantId = FGA_TENANT_ID } = {}) {
  try {
    const { data, error } = await db.from('tenant_config').select('value')
      .eq('tenant_id', tenantId).eq('key', 'revenue_daily_target').limit(1);
    if (error) return { target: DEFAULTS.dailyTarget, source: 'error_fallback' };
    if (!data || !data.length) return { target: DEFAULTS.dailyTarget, source: 'default' };
    const n = Number(data[0].value);
    return Number.isFinite(n) && n > 0
      ? { target: n, source: 'config' }
      : { target: DEFAULTS.dailyTarget, source: 'default' };
  } catch {
    return { target: DEFAULTS.dailyTarget, source: 'error_fallback' };
  }
}

/** sent_via values that mean "not a real delivery" and must never be counted. */
const NON_DELIVERY_VIA = new Set(['dev_logged', 'dev', 'test', 'simulated', 'dry_run', 'preview', 'noop']);

/**
 * Decide whether one activity_log row is a genuine, provider-accepted email.
 *
 * Every rejection carries a reason so exclusions appear as evidence on the
 * dashboard instead of a number quietly shrinking. Previously this function
 * did not exist and ANY row with action='outreach_sent' counted — a row with
 * provider_id null and sent_via 'dev_logged' scored as a successful first
 * touch, which meant the invariant could be satisfied without a single email
 * leaving the building.
 */
function classifySendRow(row) {
  const m = row.metadata || {};
  if (!row.entity_id) return { ok: false, reason: 'no_lead_id' };
  if (m.channel && m.channel !== 'email') return { ok: false, reason: `channel_${m.channel}` };
  if (NON_DELIVERY_VIA.has(String(m.sent_via || '').toLowerCase())) {
    return { ok: false, reason: `non_delivery_${m.sent_via}` };
  }
  // Provider acceptance is the only proof the message left the building: this
  // is the id the ESP returned. No id, no send — regardless of what the row says.
  if (!m.provider_id || typeof m.provider_id !== 'string') {
    return { ok: false, reason: 'no_provider_acceptance' };
  }
  if (!m.recipient) return { ok: false, reason: 'no_recipient' };
  // Eligibility evidence: sequence_id is stamped by the core/outreach-send.js
  // choke point, which is where suppression, dedupe, caps and the gate engine
  // are enforced. A provider-accepted row WITHOUT it (e.g. a manual or mobile
  // send that bypassed the pipeline) may be a real email, but it is not a
  // gated, qualified first touch and must not satisfy the invariant.
  if (!m.sequence_id) return { ok: false, reason: 'no_gate_receipt' };
  return { ok: true };
}

/**
 * Count today's REAL first-touch sends.
 *
 * Three independent things must hold for a row to count:
 *   1. Provider acceptance — metadata.provider_id from the ESP (classifySendRow).
 *   2. Uniqueness on lead id — a retry storm cannot manufacture the number.
 *   3. First touch — the lead had no accepted outreach on any earlier day.
 *
 * Rejections are returned, not silently dropped, so "21 sent" can always be
 * reconciled against the raw event count.
 */
async function countFirstTouchSends(db, { date = new Date(), tenantId = FGA_TENANT_ID } = {}) {
  const { date: etDate } = etParts(date);
  const { startIso, endIso } = etDayRangeIso(etDate);
  const base = () => db
    .from('activity_log')
    .select('entity_id, created_at, metadata')
    .eq('tenant_id', tenantId)
    .eq('action', 'outreach_sent');

  const [{ data, error }, prior] = await Promise.all([
    base().gte('created_at', startIso).lt('created_at', endIso)
      .order('created_at', { ascending: true }).limit(2000),
    // Leads already touched before today. Only accepted sends establish a
    // prior touch, so a failed attempt last week does not disqualify today.
    base().lt('created_at', startIso).limit(20000),
  ]);
  if (error) throw new Error(`countFirstTouchSends failed: ${error.message}`);
  // FAIL CLOSED on prior history. If this read fails, "first touch" cannot be
  // verified — swallowing the error (as an earlier version did) reported
  // repeat prospects as fresh first touches, inflating the number the whole
  // department is judged on. An unavailable count surfaces as "outcome
  // unknown", which is the designed failure mode; a wrong count is not.
  if (prior.error) {
    throw new Error(`countFirstTouchSends: prior-history read failed, first-touch unverifiable: ${prior.error.message}`);
  }

  const previouslyTouched = new Set(
    (prior.data || []).filter((r) => classifySendRow(r).ok).map((r) => r.entity_id),
  );

  /*
   * GATE-RECEIPT VERIFICATION — a metadata field is a claim, not evidence.
   *
   * A sequence_id in metadata proves nothing by itself: the mobile/manual
   * paths also stamp one, and a fabricated activity row can carry any string.
   * So every candidate is verified against the durable records:
   *
   *   1. Its sequence_id must exist in outreach_sequences, FGA-scoped, for the
   *      SAME lead, email-type, in a sent state. That binds tenant + lead +
   *      sequence + channel to a pipeline draft that actually went out —
   *      drafts only ever come from the outreach agent's scored/ICP pipeline.
   *   2. An auto_send additionally needs a same-day accepted row in
   *      autosend_decisions — the append-only ledger the gate engine writes.
   *      No decision row, no autonomous send, whatever the metadata says.
   *
   * bulk_send / individual / mobile are OWNER-approved sends of those same
   * pipeline drafts. Patrick's explicit approval IS the qualification gate on
   * those paths; the sequence-row check above is what keeps that from becoming
   * a loophole for events that never touched the pipeline at all.
   *
   * Both reads fail CLOSED: unverifiable is unknown, and unknown must never
   * be counted.
   */
  const candidates = [];
  for (const row of data || []) {
    const verdict = classifySendRow(row);
    if (verdict.ok) candidates.push(row);
  }
  const candidateSeqIds = [...new Set(candidates.map((r) => r.metadata.sequence_id))];

  let verifiedSequences = new Map();
  let acceptedDecisions = new Set();
  if (candidateSeqIds.length) {
    const [seqRes, decRes] = await Promise.all([
      db.from('outreach_sequences').select('id, lead_id, sequence_type, sequence_status')
        .eq('tenant_id', tenantId).in('id', candidateSeqIds).limit(2000),
      db.from('autosend_decisions').select('lead_id, sequence_id, decision')
        .eq('tenant_id', tenantId).eq('decision', 'sent')
        .gte('created_at', startIso).lt('created_at', endIso).limit(2000),
    ]);
    if (seqRes.error) {
      throw new Error(`countFirstTouchSends: sequence verification failed, gate receipts unverifiable: ${seqRes.error.message}`);
    }
    if (decRes.error) {
      throw new Error(`countFirstTouchSends: gate-decision read failed, autonomous sends unverifiable: ${decRes.error.message}`);
    }
    verifiedSequences = new Map((seqRes.data || []).map((s) => [s.id, s]));
    // Keyed by SEQUENCE, not lead. A lead-level key let an accepted decision
    // for sequence A vouch for a send of sequence B on the same lead — the
    // receipt must be for the exact message that went out.
    acceptedDecisions = new Set((decRes.data || []).filter((d) => d.sequence_id).map((d) => d.sequence_id));
  }

  const seen = new Set();
  const prospects = [];
  const rejected = {};
  const reject = (reason) => { rejected[reason] = (rejected[reason] || 0) + 1; };

  for (const row of data || []) {
    const verdict = classifySendRow(row);
    if (!verdict.ok) { reject(verdict.reason); continue; }
    const id = row.entity_id;
    const m = row.metadata;

    const seq = verifiedSequences.get(m.sequence_id);
    if (!seq) { reject('sequence_not_found'); continue; }
    if (seq.lead_id !== id) { reject('sequence_lead_mismatch'); continue; }
    if (seq.sequence_type !== 'email') { reject('sequence_wrong_channel'); continue; }
    if (!['sent', 'sending'].includes(seq.sequence_status)) { reject('sequence_not_sent_state'); continue; }
    if (m.sent_via === 'auto_send' && !acceptedDecisions.has(m.sequence_id)) {
      reject('no_gate_decision'); continue;
    }

    if (seen.has(id)) { reject('duplicate_same_day'); continue; }
    if (previouslyTouched.has(id)) { reject('not_first_touch'); continue; }
    seen.add(id);
    prospects.push({
      lead_id: id,
      sent_at: m.sent_at || row.created_at,
      recipient: m.recipient || null,
      via: m.sent_via || null,
      provider_id: m.provider_id || null,
      sequence_id: m.sequence_id,
    });
  }

  const rawEvents = (data || []).length;
  return {
    etDate,
    count: prospects.length,
    rawEvents,
    // Kept for callers that already read this field; it now means every kind
    // of exclusion, itemised in `rejected`.
    duplicatesExcluded: rawEvents - prospects.length,
    rejected,
    prospects,
    window: { startIso, endIso },
  };
}

module.exports = {
  FGA_TENANT_ID,
  ET,
  DEFAULTS,
  HEALTH,
  UNHEALTHY,
  etParts,
  etDayRangeIso,
  isBusinessDay,
  expectedByNow,
  currentCheckpoint,
  pastDeadline,
  assessHealth,
  classifySendRow,
  NON_DELIVERY_VIA,
  lastCompletedBusinessDay,
  isUnhealthy,
  countFirstTouchSends,
  readDailyTarget,
};
