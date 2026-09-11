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
const { FGA_TENANT_ID } = require('../core/config');

const {
  tierOf,
  chooseWeeklyIndustries,
  buildDiscoveryQueries,
  scoreCandidate,
  discoveryScoreThreshold,
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
  assessProspectingReadiness,
  ProspectingConfigurationError,
  isQualifiedSupplyLead,
  qualifiedSupplyTarget,
  enqueueFgaScoringHandoff,
  prospectingSupplyDecision,
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

test('FGA adaptive pacing compares qualified supply to a qualified-supply target', () => {
  assert.strictEqual(qualifiedSupplyTarget(50, 175), 210);
  assert.strictEqual(qualifiedSupplyTarget(250, 175), 250, 'explicit higher floor wins');
  assert.strictEqual(qualifiedSupplyTarget(50, 1000), 600, 'provider work remains capped');
});

test('FGA discovery follows draft demand while customer discovery remains unchanged', () => {
  assert.deepStrictEqual(
    prospectingSupplyDecision(FGA_TENANT_ID, { available: true, hold: true }),
    { proceed: false, reason: 'draft_inventory_sufficient' },
  );
  assert.deepStrictEqual(
    prospectingSupplyDecision(FGA_TENANT_ID, { available: false, hold: true }),
    { proceed: false, reason: 'draft_inventory_unverified' },
  );
  assert.deepStrictEqual(
    prospectingSupplyDecision(FGA_TENANT_ID, { available: true, hold: false }),
    { proceed: true, reason: 'draft_inventory_below_target' },
  );
  assert.deepStrictEqual(
    prospectingSupplyDecision('customer-tenant', { available: true, hold: true }),
    { proceed: true, reason: 'customer_tenant_unchanged' },
  );
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

test('FGA wide-net rotation spans 12 industries while customer rotation stays unchanged', () => {
  const weekStart = '2026-09-01';
  const fga = chooseWeeklyIndustries(FULL_POOL, weekStart, 12, null, { wideNet: true });
  const customer = chooseWeeklyIndustries(FULL_POOL, weekStart, 4, null);
  assert.strictEqual(fga.length, 12);
  assert.strictEqual(new Set(fga.map((value) => value.toLowerCase())).size, 12);
  assert.strictEqual(customer.length, 4);
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

test('each capped FGA discovery window spans the wide industry set', () => {
  const industries = ['Plumbing', 'HVAC', 'Roofing', 'Bookkeepers', 'Towing', 'Cleaning Services', 'Pool Service', 'Hair Salons', 'Moving Companies', 'DJs', 'Landscaping', 'Electricians'];
  const queries = buildDiscoveryQueries(industries, STATES_11, 30, 0, { wideNet: true });
  const represented = industries.filter((industry) => queries.some((query) => query.includes(industry)));
  assert.ok(represented.length >= 9, `only ${represented.length} industries represented: ${represented.join(', ')}`);
});

test('FGA wide-net queries include a micro-team evidence lane without narrowing industry breadth', () => {
  const industries = ['Plumbing', 'HVAC', 'Roofing', 'Bookkeepers', 'Towing', 'Cleaning Services', 'Pool Service', 'Hair Salons', 'Moving Companies', 'DJs', 'Landscaping', 'Electricians'];
  const queries = buildDiscoveryQueries(industries, STATES_11, 30, 0, { wideNet: true });
  const microQueries = queries.filter((query) => query.includes('"team of 2"'));
  assert.strictEqual(microQueries.length, 10, 'one of every three FGA searches should seek source-visible 1-9 evidence');
  const represented = industries.filter((industry) => microQueries.some((query) => query.includes(industry)));
  assert.ok(represented.length >= 9, `micro-team lane represented only ${represented.length} industries`);
});

test('new FGA qualified supply is durably handed to scoring and customer tenants are unchanged', async () => {
  const inserted = [];
  const client = {
    from(table) {
      return {
        async insert(row) {
          inserted.push({ table, row });
          return { error: null };
        },
      };
    },
  };

  const fga = await enqueueFgaScoringHandoff(client, FGA_TENANT_ID, 'lead-fga');
  assert.deepStrictEqual(fga, { queued: true });
  assert.deepStrictEqual(inserted, [{
    table: 'agent_jobs',
    row: {
      tenant_id: FGA_TENANT_ID,
      agent_name: 'scoring',
      payload: { lead_id: 'lead-fga', source: 'prospecting_handoff' },
      status: 'pending',
      priority: 7,
    },
  }]);

  const customer = await enqueueFgaScoringHandoff(client, 'customer-tenant', 'lead-customer');
  assert.deepStrictEqual(customer, { queued: false, reason: 'customer_tenant_unchanged' });
  assert.strictEqual(inserted.length, 1, 'customer tenant must not receive a new scoring job');
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

test('scoreCandidate: FGA prefers 1-9, accepts 10-19, and excludes 20+', () => {
  const cfg = { targetStates: ['TN'], targetIndustries: ['Plumbing'], excludedIndustries: [], excludedKeywords: [], requireNoWebsite: false, employeeMin: 1, employeeMax: 19, extendedEmployeeBand: true };
  const base = { company: 'X', industry: 'Plumbing', state: 'TN', phone: '123', website: null };
  const nine = scoreCandidate({ ...base, employee_count: 9 }, cfg);
  const eleven = scoreCandidate({ ...base, employee_count: 11 }, cfg);
  const twenty = scoreCandidate({ ...base, employee_count: 20 }, cfg);
  assert.ok(nine > eleven, 'the 1-9 sweet spot must outrank 10-19');
  assert.ok(eleven >= 50, `11 employees should remain prospecting-eligible, got ${eleven}`);
  assert.ok(twenty < 0, `20 employees must be excluded, got ${twenty}`);
});

test('FGA raw discovery can reach enrichment without weakening final qualification', () => {
  assert.strictEqual(discoveryScoreThreshold(FGA_TENANT_ID, 50), 30);
  assert.strictEqual(discoveryScoreThreshold(FGA_TENANT_ID, 20), 20);
  assert.strictEqual(discoveryScoreThreshold('customer-tenant', 50), 50);

  const cfg = {
    targetStates: ['TN'], targetIndustries: ['Plumbing'],
    excludedIndustries: [], excludedKeywords: [], requireNoWebsite: false,
    employeeMin: 1, employeeMax: 19, extendedEmployeeBand: true,
  };
  const rawSearchCandidate = {
    company: 'Example local business', industry: 'Plumbing', state: 'TN',
    website: 'https://example.invalid', employee_count: null,
  };
  const discoveryScore = scoreCandidate(rawSearchCandidate, cfg);
  assert.ok(discoveryScore >= discoveryScoreThreshold(FGA_TENANT_ID, 50));
  assert.ok(discoveryScore < 50, 'the old final-score prefilter would have stranded this candidate');
  const customerLegacyScore = scoreCandidate(rawSearchCandidate, {
    ...cfg, employeeMax: 5, extendedEmployeeBand: false,
  });
  assert.ok(customerLegacyScore < 0, 'customer-tenant null-size scoring must remain unchanged');
  assert.equal(
    isQualifiedSupplyLead({ metadata: {} }, FGA_TENANT_ID),
    false,
    'reaching enrichment must never itself qualify the lead for outreach',
  );
});

test('FGA qualified supply means email plus a 1-19 employee fit', () => {
  const contact = { metadata: { contact_channels_found: ['email'] } };
  assert.equal(isQualifiedSupplyLead({ ...contact, size: '1-5' }, FGA_TENANT_ID), true);
  assert.equal(isQualifiedSupplyLead({ ...contact, size: '11-19' }, FGA_TENANT_ID), true);
  assert.equal(isQualifiedSupplyLead(contact, FGA_TENANT_ID), false, 'unknown size is research, not qualified supply');
  assert.equal(isQualifiedSupplyLead({ ...contact, size: '20-50' }, FGA_TENANT_ID), false);
  assert.equal(isQualifiedSupplyLead({ size: '1-5', metadata: {} }, FGA_TENANT_ID), false, 'size alone is not reachable');
});

test('customer tenants retain the legacy contact-found qualification definition', () => {
  const contactOnly = { metadata: { contact_channels_found: ['email'] } };
  assert.equal(isQualifiedSupplyLead(contactOnly, 'customer-tenant'), true);
  assert.equal(isQualifiedSupplyLead({ ...contactOnly, size: '20-50' }, 'customer-tenant'), true);
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

test('prospecting preflight fails closed before work when tenant prerequisites are missing', () => {
  const readiness = assessProspectingReadiness(
    { id: 'tenant-a', config: {} },
    {},
    {},
  );
  assert.strictEqual(readiness.ready, false);
  assert.deepStrictEqual(
    readiness.missing,
    ['SERPER_API_KEY', 'target_industries', 'target_states'],
  );
  const error = new ProspectingConfigurationError(readiness);
  assert.strictEqual(error.reasonCode, 'prospecting_configuration_invalid');
  assert.strictEqual(error.evidence.missing_count, 3);
  assert.ok(!error.message.includes('tenant-a'));
});

test('prospecting preflight accepts bounded complete configuration', () => {
  const readiness = assessProspectingReadiness(
    {
      id: 'tenant-a',
      config: {
        target_states: ['ga', 'FL'],
        target_industries: ['Plumbing', 'HVAC'],
      },
    },
    {},
    { SERPER_API_KEY: 'configured-for-test' },
  );
  assert.strictEqual(readiness.ready, true);
  assert.deepStrictEqual(readiness.values.targetStates, ['GA', 'FL']);
  assert.deepStrictEqual(readiness.invalid, []);
});

test('FGA preflight uses 1-19 and wide rotation without changing customer tenant config', () => {
  const baseConfig = {
    target_states: ['GA'], target_industries: FULL_POOL,
    min_employees: 20, max_employees: 150, industries_per_week: 4,
  };
  const fga = assessProspectingReadiness(
    { id: FGA_TENANT_ID, config: baseConfig }, {}, { SERPER_API_KEY: 'test' },
  );
  const customer = assessProspectingReadiness(
    { id: 'customer-tenant', config: baseConfig }, {}, { SERPER_API_KEY: 'test' },
  );
  assert.strictEqual(fga.values.employeeMin, 1);
  assert.strictEqual(fga.values.employeeMax, 19);
  assert.strictEqual(fga.values.industriesPerWeek, 12);
  assert.strictEqual(customer.values.employeeMin, 20);
  assert.strictEqual(customer.values.employeeMax, 150);
  assert.strictEqual(customer.values.industriesPerWeek, 4);
});

test('prospecting preflight rejects unbounded or contradictory numeric configuration', () => {
  const readiness = assessProspectingReadiness(
    {
      id: 'tenant-a',
      config: {
        target_states: ['GA'],
        target_industries: ['Plumbing'],
        min_employees: 20,
        max_employees: 5,
        max_serper_calls_per_run: 1000,
      },
    },
    {},
    { SERPER_API_KEY: 'configured-for-test' },
  );
  assert.strictEqual(readiness.ready, false);
  assert.ok(readiness.invalid.includes('employee_range'));
  assert.ok(readiness.invalid.includes('max_serper_calls_per_run'));
});
