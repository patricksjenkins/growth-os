/**
 * Prospecting agent — pure-logic unit tests for the 2026-06-11 scale-up
 * (15→50/week, 1-5 employees, multi-industry rotation, tier mix, bounded
 * Serper, geography expansion). No DB / no network: only the exported pure
 * helpers are exercised.
 */

'use strict';

// prospecting.js requires db/client at load; give it dummy env so require
// doesn't throw. None of the pure helpers under test touch the DB.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  tierOf,
  chooseWeeklyIndustries,
  buildDiscoveryQueries,
  scoreCandidate,
  digitalPresenceStatus,
  moduleFit,
  normalizeSize,
  TIER1_INDUSTRIES,
  TIER2_INDUSTRIES,
  TIER3_INDUSTRIES,
  NEWLY_ADDED_STATES,
  DEFAULT_WEEKLY_TARGET,
  DEFAULT_DAILY_CANDIDATE_CAP,
  DEFAULT_MAX_SERPER_CALLS_PER_RUN,
} = require('../worker/agents/prospecting')._internals;

const FULL_POOL = [...TIER1_INDUSTRIES, ...TIER2_INDUSTRIES, ...TIER3_INDUSTRIES];
const STATES_11 = ['GA', 'FL', 'AL', 'TN', 'SC', 'NC', 'MS', 'LA', 'VA', 'KY', 'AR'];

test('defaults reflect the autonomous-outbound scale-up (2026-07-03)', () => {
  // Base weekly target stays 50; the ADAPTIVE target raises it when
  // autonomous outreach is armed (see computeAdaptiveWeeklyTarget).
  assert.strictEqual(DEFAULT_WEEKLY_TARGET, 50);
  assert.strictEqual(DEFAULT_DAILY_CANDIDATE_CAP, 150);
  assert.strictEqual(DEFAULT_MAX_SERPER_CALLS_PER_RUN, 45);
});

test('tierOf classifies known industries and defaults unknown to tier 2', () => {
  assert.strictEqual(tierOf('Plumbing'), 1);
  assert.strictEqual(tierOf('hvac'), 1); // case-insensitive
  assert.strictEqual(tierOf('Bookkeepers'), 2);
  assert.strictEqual(tierOf('Florists'), 3);
  assert.strictEqual(tierOf('Something Unknown'), 2);
});

test('weekly industry mix: 3-5 industries, >=2 Tier1, <=1 Tier3, no dupes', () => {
  // Check several consecutive weeks for the tier constraints.
  for (let w = 0; w < 20; w++) {
    const weekStart = new Date(Date.UTC(2026, 0, 6 + w * 7)).toISOString().slice(0, 10);
    const chosen = chooseWeeklyIndustries(FULL_POOL, weekStart, 4, null);
    assert.ok(chosen.length >= 3 && chosen.length <= 5, `size ${chosen.length}`);
    const t1 = chosen.filter((i) => tierOf(i) === 1).length;
    const t3 = chosen.filter((i) => tierOf(i) === 3).length;
    assert.ok(t1 >= 2, `week ${w}: expected >=2 Tier1, got ${t1} in ${chosen}`);
    assert.ok(t3 <= 1, `week ${w}: expected <=1 Tier3, got ${t3} in ${chosen}`);
    const lower = chosen.map((s) => s.toLowerCase());
    assert.strictEqual(new Set(lower).size, lower.length, `dupes in ${chosen}`);
  }
});

test('weekly mix avoids repeating the previous exact combo', () => {
  const weekStart = '2026-01-06';
  const first = chooseWeeklyIndustries(FULL_POOL, weekStart, 4, null);
  const again = chooseWeeklyIndustries(FULL_POOL, weekStart, 4, first);
  assert.notStrictEqual(
    first.map((s) => s.toLowerCase()).sort().join('|'),
    again.map((s) => s.toLowerCase()).sort().join('|'),
  );
});

test('only industries in the tenant pool are eligible', () => {
  const smallPool = ['Plumbing', 'HVAC', 'Electrical', 'Roofing'];
  const chosen = chooseWeeklyIndustries(smallPool, '2026-02-10', 4, null);
  for (const c of chosen) {
    assert.ok(smallPool.some((p) => p.toLowerCase() === c.toLowerCase()), `${c} not in pool`);
  }
});

test('discovery queries never exceed the per-run Serper cap', () => {
  const industries = ['Plumbing', 'HVAC', 'Roofing', 'Bookkeepers'];
  const q = buildDiscoveryQueries(industries, STATES_11, DEFAULT_MAX_SERPER_CALLS_PER_RUN, 0);
  assert.ok(q.length <= DEFAULT_MAX_SERPER_CALLS_PER_RUN, `got ${q.length}`);
  assert.ok(q.length > 0);
});

test('discovery queries include a newly-added state within the capped slice', () => {
  const q = buildDiscoveryQueries(['Plumbing', 'HVAC'], STATES_11, 30, 0);
  const joined = q.join(' ');
  const hasNewState = ['North Carolina', 'Mississippi', 'Louisiana', 'Virginia', 'Kentucky', 'Arkansas']
    .some((n) => joined.includes(n));
  assert.ok(hasNewState, 'capped slice should mix in a newly-added state');
});

test('scoreCandidate: 1-5 employees scores full size credit', () => {
  const cfg = { targetStates: ['TN'], targetIndustries: ['Plumbing'], excludedIndustries: [], excludedKeywords: [], requireNoWebsite: true, employeeMin: 1, employeeMax: 5 };
  const base = { company: 'X', industry: 'Plumbing', state: 'TN', phone: '123', website: null };
  const five = scoreCandidate({ ...base, employee_count: 5 }, cfg);
  const eight = scoreCandidate({ ...base, employee_count: 8 }, cfg);
  assert.ok(five > eight, 'a 5-employee shop should outscore an 8-employee one');
});

test('scoreCandidate: owned website is rejected when require_no_website', () => {
  const cfg = { targetStates: ['TN'], targetIndustries: ['Plumbing'], excludedIndustries: [], excludedKeywords: [], requireNoWebsite: true, employeeMin: 1, employeeMax: 5 };
  const withSite = scoreCandidate({ company: 'X', industry: 'Plumbing', state: 'TN', employee_count: 2, website: 'https://acme.com' }, cfg);
  assert.ok(withSite < 0, `owned-site candidate should be heavily penalized, got ${withSite}`);
});

test('digitalPresenceStatus distinguishes owned/social/directory', () => {
  assert.strictEqual(digitalPresenceStatus({ website: 'https://acme.com' }), 'Owned Website');
  assert.strictEqual(digitalPresenceStatus({ website: null, facebook_url: 'https://facebook.com/acme' }), 'Social Only');
  assert.strictEqual(digitalPresenceStatus({ website: null, listed_in_google_maps: true }), 'Directory Only');
  assert.strictEqual(digitalPresenceStatus({ website: null }), 'Unclear');
});

test('moduleFit returns a primary+secondary module and angle per tier', () => {
  const t1 = moduleFit({ industry: 'Plumbing', website: null });
  assert.ok(t1.primary && t1.secondary && t1.pain_point && t1.outreach_angle);
  assert.strictEqual(t1.voice_receptionist_fit, true);
  const t2 = moduleFit({ industry: 'Bookkeepers', website: null });
  assert.strictEqual(t2.voice_receptionist_fit, false);
});

test('normalizeSize bands on the 1-5 ICP', () => {
  assert.strictEqual(normalizeSize(null, '1-5'), '1-5'); // explicit passthrough
  assert.strictEqual(normalizeSize(4), '1-5');
  assert.strictEqual(normalizeSize(8), '6-10');
});

test('NEWLY_ADDED_STATES cover the 2026-07-03 nationwide expansion', () => {
  // 38 states beyond the established 11 southeastern ones (lower-48 + DC,
  // minus AK/HI). The interleave keeps capped runs geographically mixed.
  assert.strictEqual(NEWLY_ADDED_STATES.length, 38);
  for (const st of ['TX', 'CA', 'NY', 'OH', 'DC']) {
    assert.ok(NEWLY_ADDED_STATES.includes(st), `missing ${st}`);
  }
  for (const original of ['GA', 'FL', 'AL', 'TN', 'SC', 'NC', 'MS', 'LA', 'VA', 'KY', 'AR']) {
    assert.ok(!NEWLY_ADDED_STATES.includes(original), `${original} should not be in the new-states list`);
  }
});
