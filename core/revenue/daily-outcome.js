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
  businessDays: [1, 2, 3, 4, 5], // Mon-Fri, ISO weekday
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
    base().lt('created_at', startIso).limit(20000)
      .then((r) => r, () => ({ data: [], error: null })),
  ]);
  if (error) throw new Error(`countFirstTouchSends failed: ${error.message}`);

  const previouslyTouched = new Set(
    (prior.data || []).filter((r) => classifySendRow(r).ok).map((r) => r.entity_id),
  );

  const seen = new Set();
  const prospects = [];
  const rejected = {};
  const reject = (reason) => { rejected[reason] = (rejected[reason] || 0) + 1; };

  for (const row of data || []) {
    const verdict = classifySendRow(row);
    if (!verdict.ok) { reject(verdict.reason); continue; }
    const id = row.entity_id;
    if (seen.has(id)) { reject('duplicate_same_day'); continue; }
    if (previouslyTouched.has(id)) { reject('not_first_touch'); continue; }
    seen.add(id);
    prospects.push({
      lead_id: id,
      sent_at: row.metadata?.sent_at || row.created_at,
      recipient: row.metadata?.recipient || null,
      via: row.metadata?.sent_via || null,
      provider_id: row.metadata?.provider_id || null,
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
};
