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

test('business days and timezone are handled in ET, not UTC', () => {
  assert.strictEqual(isBusinessDay(WED_1100_ET), true);
  assert.strictEqual(isBusinessDay(SAT_1100_ET), false);
  assert.strictEqual(isBusinessDay(SUN_1100_ET), false);
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

test('weekends are not failures', () => {
  const r = assessHealth({ target: 25, sentToday: 0, now: SAT_1100_ET });
  assert.strictEqual(r.health, HEALTH.NOT_A_BUSINESS_DAY);
  assert.strictEqual(isUnhealthy(r.health), false);
});

test('on pace but incomplete is healthy_in_progress', () => {
  const r = assessHealth({ target: 25, sentToday: 20, inventory: { sendReady: 30 }, now: WED_1400_ET });
  assert.strictEqual(r.health, HEALTH.HEALTHY_IN_PROGRESS);
  assert.strictEqual(r.remaining, 5);
});

/* ── Counting rules ── */

function stubDb(rows) {
  const b = {
    select: () => b, eq: () => b, gte: () => b, lt: () => b,
    order: () => b, limit: () => b,
    then: (res) => Promise.resolve({ data: rows, error: null }).then(res),
  };
  return { from: () => b };
}

test('duplicate sends to the same prospect count ONCE', async () => {
  const db = stubDb([
    { entity_id: 'lead-a', created_at: '2026-07-22T14:00:00Z', metadata: { recipient: 'a@x.com' } },
    { entity_id: 'lead-a', created_at: '2026-07-22T14:05:00Z', metadata: { recipient: 'a@x.com' } },
    { entity_id: 'lead-a', created_at: '2026-07-22T14:10:00Z', metadata: { recipient: 'a@x.com' } },
    { entity_id: 'lead-b', created_at: '2026-07-22T14:20:00Z', metadata: { recipient: 'b@x.com' } },
  ]);
  const r = await countFirstTouchSends(db, { date: WED_1400_ET });
  assert.strictEqual(r.count, 2, 'a retry storm must not inflate the number');
  assert.strictEqual(r.rawEvents, 4);
  assert.strictEqual(r.duplicatesExcluded, 2);
});

test('rows without a prospect id are not counted', async () => {
  const db = stubDb([
    { entity_id: null, created_at: '2026-07-22T14:00:00Z', metadata: {} },
    { entity_id: 'lead-a', created_at: '2026-07-22T14:01:00Z', metadata: {} },
  ]);
  const r = await countFirstTouchSends(db, { date: WED_1400_ET });
  assert.strictEqual(r.count, 1);
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
