/**
 * The daily revenue invariant (2026-07-25).
 *
 * "25 first-touch emails per business day" is the number the department is
 * judged on, so these tests pin the counting rules hard: a skipped run, a
 * retry, a draft, a drip follow-up, or a client-tenant send must never be
 * able to make the number look better than reality.
 */

const test = require('node:test');
const assert = require('node:assert');
const {
  DEFAULTS, HEALTH, etParts, etDayRangeIso, isBusinessDay, expectedByNow,
  currentCheckpoint, pastDeadline, assessHealth, isUnhealthy, countFirstTouchSends,
} = require('../core/revenue/daily-outcome');

// Fixed instants (UTC) mapped to known ET wall-clock times, EDT = UTC-4.
const WED_0700_ET = new Date('2026-07-22T11:00:00Z');
const WED_1100_ET = new Date('2026-07-22T15:00:00Z');
const WED_1400_ET = new Date('2026-07-22T18:00:00Z');
const WED_1730_ET = new Date('2026-07-22T21:30:00Z');
const SAT_1100_ET = new Date('2026-07-25T15:00:00Z'); // 2026-07-25 is a Saturday
const SUN_1100_ET = new Date('2026-07-26T15:00:00Z');

test('target defaults to 25 and is configurable', () => {
  assert.strictEqual(DEFAULTS.dailyTarget, 25);
  assert.strictEqual(expectedByNow(50, WED_1730_ET), 50, 'a different target scales the curve');
});

test('EVERY day is an outreach day by default (Patrick directive 2026-07-26)', () => {
  assert.strictEqual(isBusinessDay(WED_1100_ET), true);
  assert.strictEqual(isBusinessDay(SAT_1100_ET), true, 'Saturday sends');
  assert.strictEqual(isBusinessDay(SUN_1100_ET), true, 'Sunday sends');
  // Weekday-only stays available as configuration for a future tenant.
  const WEEKDAYS = { businessDays: [1, 2, 3, 4, 5] };
  assert.strictEqual(isBusinessDay(SAT_1100_ET, WEEKDAYS), false);
  // A UTC instant that is still the previous day in ET must resolve to ET.
  const lateUtc = new Date('2026-07-23T02:00:00Z'); // 2026-07-22 22:00 ET
  assert.strictEqual(etParts(lateUtc).date, '2026-07-22');
});

test('ET day range is exactly 24h and offset-correct', () => {
  const { startIso, endIso } = etDayRangeIso('2026-07-22');
  assert.strictEqual(new Date(endIso) - new Date(startIso), 86400000);
  assert.strictEqual(startIso, '2026-07-22T04:00:00.000Z', 'EDT is UTC-4');
});

test('pace expectations follow the checkpoint curve', () => {
  const t = 25;
  assert.strictEqual(expectedByNow(t, WED_0700_ET), 0, 'not behind at 7am');
  assert.strictEqual(expectedByNow(t, WED_1100_ET), 5, '20% by 10:30');
  assert.strictEqual(expectedByNow(t, WED_1400_ET), 13, '50% by 13:30');
  assert.strictEqual(expectedByNow(t, WED_1730_ET), 25, '100% by 17:00');
});

test('nothing is expected on a configured non-business day', () => {
  // Regression: the live dashboard read "0 of 13 expected" on an off day —
  // a correctly idle department shown as failing. The default is now all
  // seven days, so the guard is exercised through configuration.
  const SAT_1400_ET = new Date('2026-07-25T18:00:00Z');
  const WEEKDAYS = { businessDays: [1, 2, 3, 4, 5] };
  assert.strictEqual(isBusinessDay(SAT_1400_ET, WEEKDAYS), false);
  assert.strictEqual(expectedByNow(25, SAT_1400_ET, WEEKDAYS), 0, 'off day expects nothing');
  assert.strictEqual(expectedByNow(25, SAT_1400_ET), 13, 'default: Saturday is a working day');
});

test('checkpoints and deadline resolve correctly', () => {
  assert.strictEqual(currentCheckpoint(WED_0700_ET), null);
  assert.strictEqual(currentCheckpoint(WED_1400_ET).label, 'midday_half');
  assert.strictEqual(pastDeadline(WED_1400_ET), false);
  assert.strictEqual(pastDeadline(WED_1730_ET), true);
});

/* ── Health: a skipped run is never success ── */

test('hitting the target is the only healthy_on_target', () => {
  const r = assessHealth({ target: 25, sentToday: 25, now: WED_1400_ET });
  assert.strictEqual(r.health, HEALTH.HEALTHY_ON_TARGET);
  assert.strictEqual(isUnhealthy(r.health), false);
});

test('zero sends at midday is BEHIND, never healthy', () => {
  const r = assessHealth({ target: 25, sentToday: 0, inventory: { sendReady: 99 }, now: WED_1400_ET });
  assert.strictEqual(r.health, HEALTH.BEHIND_TARGET);
  assert.strictEqual(isUnhealthy(r.health), true);
});

test('zero sends past the deadline is MISSED — the invariant violation', () => {
  const r = assessHealth({ target: 25, sentToday: 0, inventory: { sendReady: 99 }, now: WED_1730_ET });
  assert.strictEqual(r.health, HEALTH.MISSED_DAILY_OUTCOME);
  assert.match(r.reason, /0\/25/);
});

test('THE INCIDENT: a paused sender reads as blocked_deliverability, not healthy', () => {
  const r = assessHealth({
    target: 25, sentToday: 0, inventory: { sendReady: 99 },
    blockers: { deliverability: 'paused: 1 hard bounce / 24 sends' },
    now: WED_1400_ET,
  });
  assert.strictEqual(r.health, HEALTH.BLOCKED_DELIVERABILITY,
    'the two-day outage must surface as a specific blocked state');
  assert.strictEqual(isUnhealthy(r.health), true);
});

test('a specific blocker outranks a generic behind-target', () => {
  const base = { target: 25, sentToday: 0, inventory: { sendReady: 99 }, now: WED_1400_ET };
  assert.strictEqual(assessHealth({ ...base, blockers: { configuration: 'ICP target_states missing' } }).health,
    HEALTH.BLOCKED_CONFIGURATION);
  assert.strictEqual(assessHealth({ ...base, blockers: { quality: 'all drafts below send bar' } }).health,
    HEALTH.BLOCKED_QUALITY);
  assert.strictEqual(assessHealth({ ...base, blockers: { provider: 'Resend 5xx' } }).health,
    HEALTH.BLOCKED_PROVIDER);
});

test('low inventory is its own state so remediation can differ', () => {
  const r = assessHealth({ target: 25, sentToday: 2, inventory: { sendReady: 1 }, now: WED_1100_ET });
  assert.strictEqual(r.health, HEALTH.DEGRADED_INVENTORY);
  assert.match(r.reason, /send-ready/);
});

test('remediation and human-action states are distinguishable', () => {
  const base = { target: 25, sentToday: 3, inventory: { sendReady: 99 }, now: WED_1400_ET };
  assert.strictEqual(assessHealth({ ...base, remediationRunning: true }).health, HEALTH.REMEDIATION_RUNNING);
  assert.strictEqual(assessHealth({ ...base, humanActionRequired: true }).health, HEALTH.HUMAN_ACTION_REQUIRED);
});

test('Saturday is judged like any other day; off-days only exist via config', () => {
  const sat = assessHealth({ target: 25, sentToday: 0, inventory: { sendReady: 9 }, now: SAT_1100_ET });
  assert.notStrictEqual(sat.health, HEALTH.NOT_A_BUSINESS_DAY,
    'the department works weekends now — zero on Saturday is a real state, not a day off');
  const off = assessHealth({ target: 25, sentToday: 0, now: SAT_1100_ET,
    cfg: { businessDays: [1, 2, 3, 4, 5] } });
  assert.strictEqual(off.health, HEALTH.NOT_A_BUSINESS_DAY);
  assert.strictEqual(isUnhealthy(off.health), false);
});

test('on pace but incomplete is healthy_in_progress', () => {
  const r = assessHealth({ target: 25, sentToday: 20, inventory: { sendReady: 30 }, now: WED_1400_ET });
  assert.strictEqual(r.health, HEALTH.HEALTHY_IN_PROGRESS);
  assert.strictEqual(r.remaining, 5);
});

/* ── Counting rules ── */

/** Metadata of a genuine, provider-accepted send. Fixtures spread this. */
const ACCEPTED = { channel: 'email', sent_via: 'auto_send', provider_id: 'prov-1', sequence_id: 'seq-1' };
const sent = (leadId, at, extra = {}) => ({
  entity_id: leadId,
  created_at: at,
  metadata: { ...ACCEPTED, recipient: `${leadId}@x.com`, ...extra },
});

/**
 * The counter issues TWO reads: today's rows (.gte start) and every earlier
 * row (.lt start, no .gte) used to establish first-touch. The stub keeps them
 * apart — a stub that answered both with the same rows would mark every lead
 * previously-touched and quietly return zero.
 */
function stubDb(rows, priorRows = []) {
  return {
    from() {
      let sawGte = false;
      const b = {
        select: () => b, eq: () => b, order: () => b, limit: () => b,
        gte: () => { sawGte = true; return b; },
        lt: () => b,
        then: (res) => Promise.resolve({ data: sawGte ? rows : priorRows, error: null }).then(res),
      };
      return b;
    },
  };
}

test('duplicate sends to the same prospect count ONCE', async () => {
  const db = stubDb([
    sent('lead-a', '2026-07-22T14:00:00Z'),
    sent('lead-a', '2026-07-22T14:05:00Z'),
    sent('lead-a', '2026-07-22T14:10:00Z'),
    sent('lead-b', '2026-07-22T14:20:00Z'),
  ]);
  const r = await countFirstTouchSends(db, { date: WED_1400_ET });
  assert.strictEqual(r.count, 2, 'a retry storm must not inflate the number');
  assert.strictEqual(r.rawEvents, 4);
  assert.strictEqual(r.duplicatesExcluded, 2);
  assert.strictEqual(r.rejected.duplicate_same_day, 2);
});

test('rows without a prospect id are not counted', async () => {
  const db = stubDb([
    { entity_id: null, created_at: '2026-07-22T14:00:00Z', metadata: { ...ACCEPTED } },
    sent('lead-a', '2026-07-22T14:01:00Z'),
  ]);
  const r = await countFirstTouchSends(db, { date: WED_1400_ET });
  assert.strictEqual(r.count, 1);
  assert.strictEqual(r.rejected.no_lead_id, 1);
});

test('a lead touched on an earlier day is not a first touch today', async () => {
  const db = stubDb(
    [sent('lead-old', '2026-07-22T14:00:00Z'), sent('lead-new', '2026-07-22T14:01:00Z')],
    [sent('lead-old', '2026-07-15T14:00:00Z')],
  );
  const r = await countFirstTouchSends(db, { date: WED_1400_ET });
  assert.strictEqual(r.count, 1, 'only the genuinely new prospect counts');
  assert.strictEqual(r.rejected.not_first_touch, 1);
  assert.strictEqual(r.prospects[0].lead_id, 'lead-new');
});

test('a prior FAILED attempt does not disqualify a real first touch', async () => {
  // Only accepted sends establish a prior touch.
  const db = stubDb(
    [sent('lead-a', '2026-07-22T14:00:00Z')],
    [{ entity_id: 'lead-a', created_at: '2026-07-15T14:00:00Z',
       metadata: { channel: 'email', sent_via: 'auto_send', provider_id: null } }],
  );
  const r = await countFirstTouchSends(db, { date: WED_1400_ET });
  assert.strictEqual(r.count, 1);
});

test('unverifiable rows are rejected with a stated reason, not silently dropped', async () => {
  const db = stubDb([
    sent('lead-a', '2026-07-22T14:00:00Z'),
    sent('lead-b', '2026-07-22T14:01:00Z', { provider_id: null }),
    sent('lead-c', '2026-07-22T14:02:00Z', { sent_via: 'dev_logged' }),
  ]);
  const r = await countFirstTouchSends(db, { date: WED_1400_ET });
  assert.strictEqual(r.count, 1, 'only the accepted send counts');
  assert.strictEqual(r.rawEvents, 3, 'the raw total stays visible for reconciliation');
  assert.strictEqual(r.rejected.no_provider_acceptance, 1);
  assert.strictEqual(r.rejected.non_delivery_dev_logged, 1);
});

test('zero sends returns a real zero, not an error', async () => {
  const r = await countFirstTouchSends(stubDb([]), { date: WED_1400_ET });
  assert.strictEqual(r.count, 0);
  assert.deepStrictEqual(r.prospects, []);
});

test('the count is scoped to one ET day and one tenant by construction', async () => {
  // Assert the query shape rather than trusting the caller.
  const calls = [];
  const b = {
    select: (...a) => { calls.push(['select', ...a]); return b; },
    eq: (...a) => { calls.push(['eq', ...a]); return b; },
    gte: (...a) => { calls.push(['gte', ...a]); return b; },
    lt: (...a) => { calls.push(['lt', ...a]); return b; },
    order: () => b, limit: () => b,
    then: (res) => Promise.resolve({ data: [], error: null }).then(res),
  };
  await countFirstTouchSends({ from: () => b }, { date: WED_1400_ET });
  const eqs = calls.filter((c) => c[0] === 'eq').map((c) => c[1]);
  assert.ok(eqs.includes('tenant_id'), 'must filter by tenant — client sends never count');
  assert.ok(eqs.includes('action'), 'must filter to the outreach_sent action');
  assert.ok(calls.some((c) => c[0] === 'gte'), 'must bound the day start');
  assert.ok(calls.some((c) => c[0] === 'lt'), 'must bound the day end');
});

/* ── Provider acceptance: a row is not a send ──
 *
 * Codex review 2026-07-25: the counter accepted ANY activity_log row with
 * action='outreach_sent'. A synthetic row with provider_id null and
 * sent_via 'dev_logged' scored as a successful first touch, so the invariant
 * could read 25/25 with nothing delivered.
 */

const { classifySendRow } = require('../core/revenue/daily-outcome');

const REAL = {
  entity_id: 'lead-1',
  metadata: {
    channel: 'email', sent_via: 'auto_send', recipient: 'owner@example.com',
    provider_id: '09f92b5d-08ec-49f4-8298-0ba21db39cd3',
    sequence_id: '5e08c1b2-a156-43c3-b696-c91fd9e14b28',
  },
};

test('a real provider-accepted send counts', () => {
  assert.strictEqual(classifySendRow(REAL).ok, true);
});

test("THE false count: provider_id null + sent_via dev_logged is NOT a send", () => {
  const v = classifySendRow({
    entity_id: 'lead-1',
    metadata: { channel: 'email', sent_via: 'dev_logged', recipient: 'x@y.com', provider_id: null },
  });
  assert.strictEqual(v.ok, false, 'this exact row was counted as a successful first touch');
  assert.strictEqual(v.reason, 'non_delivery_dev_logged');
});

test('no provider acceptance means no send, whatever the row claims', () => {
  const v = classifySendRow({
    entity_id: 'lead-1',
    metadata: { channel: 'email', sent_via: 'auto_send', recipient: 'x@y.com' },
  });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.reason, 'no_provider_acceptance');
});

test('rows missing a lead, recipient, or on another channel do not count', () => {
  assert.strictEqual(classifySendRow({ metadata: REAL.metadata }).reason, 'no_lead_id');
  assert.strictEqual(
    classifySendRow({ entity_id: 'l', metadata: { ...REAL.metadata, recipient: null } }).reason,
    'no_recipient');
  assert.strictEqual(
    classifySendRow({ entity_id: 'l', metadata: { ...REAL.metadata, channel: 'sms' } }).reason,
    'channel_sms');
});

test('every non-delivery marker is rejected', () => {
  for (const via of ['dev_logged', 'test', 'simulated', 'dry_run', 'preview', 'noop', 'DEV']) {
    const v = classifySendRow({ entity_id: 'l', metadata: { ...REAL.metadata, sent_via: via } });
    assert.strictEqual(v.ok, false, `${via} must never count toward the daily 25`);
  }
});

test('the real production send shapes still count', () => {
  // Guard against a filter so strict it erases genuine history: all 96 rows in
  // production are bulk_send or auto_send with a Resend provider_id.
  for (const via of ['auto_send', 'bulk_send']) {
    assert.strictEqual(
      classifySendRow({ entity_id: 'l', metadata: { ...REAL.metadata, sent_via: via } }).ok,
      true, `${via} is a real delivery path and must count`);
  }
});

test("Codex probe: provider-accepted but ungated row does NOT count", () => {
  // A manual/mobile send can produce a real provider id without ever passing
  // suppression, dedupe, caps or the gate engine. Real email, not a qualified
  // first touch.
  const { classifySendRow } = require('../core/revenue/daily-outcome');
  const v = classifySendRow({
    entity_id: 'lead-1',
    metadata: { channel: 'email', sent_via: 'manual', recipient: 'x@y.com',
      provider_id: 'real-provider-id-123' },
  });
  assert.strictEqual(v.ok, false, 'no gate receipt means no qualification evidence');
  assert.strictEqual(v.reason, 'no_gate_receipt');
});

test('a failed prior-history read FAILS CLOSED instead of inventing first touches', async () => {
  // Codex probe: prior history unavailable -> a repeat prospect was reported
  // as a valid first touch. Unknown must surface as unknown, never as a count.
  const db = {
    from() {
      let sawGte = false;
      const b = {
        select: () => b, eq: () => b, order: () => b, limit: () => b,
        gte: () => { sawGte = true; return b; },
        lt: () => b,
        then: (res) => Promise.resolve(sawGte
          ? { data: [sent('lead-a', '2026-07-22T14:00:00Z')], error: null }
          : { data: null, error: { message: 'history table unavailable' } }).then(res),
      };
      return b;
    },
  };
  await assert.rejects(
    () => countFirstTouchSends(db, { date: WED_1400_ET }),
    /first-touch unverifiable/,
    'a wrong number is worse than no number');
});
