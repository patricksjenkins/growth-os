'use strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { FGA_TENANT_ID } = require('../../core/config');
const {
  computeScore,
  deterministicScoreExplanation,
  fgaScoringBlockReason,
  resolveScoringThresholds,
  selectFgaScoreVersionUpgrades,
  shouldHandoffToOutreach,
  SCORE_VERSION,
} = require('../../worker/agents/scoring')._test;

const contacts = [{ role_in_buying: 'decision_maker' }];
const baseConfig = {
  targetStates: ['GA'], targetIndustries: ['Plumbing'],
  minEmployees: 1, maxEmployees: 9,
  tierAThreshold: 60, tierBThreshold: 45,
  strictMicroBusiness: true,
};
const withEmployeeProof = (count, extra = {}) => ({
  lead_source: 'prospecting_agent',
  status: 'new_lead',
  lifecycle_stage: 'scored',
  ...extra,
  employee_count_actual: count,
  metadata: { employee_count_evidence: { count, source: 'public registry', confidence: 0.9 } },
});

test('FGA scoring is industry-neutral and prioritizes 1-9 over accepted 10-19', () => {
  const inPool = computeScore(withEmployeeProof(4, { industry: 'Plumbing', hq_state: 'GA' }), contacts, baseConfig);
  const outsidePool = computeScore(withEmployeeProof(4, { industry: 'Florist', hq_state: 'GA' }), contacts, baseConfig);
  const eleven = computeScore({ employee_count_actual: 11, industry: 'Plumbing', hq_state: 'GA' }, contacts, baseConfig);
  const twenty = computeScore({ employee_count_actual: 20, industry: 'Plumbing', hq_state: 'GA' }, contacts, baseConfig);
  const unknown = computeScore({ industry: 'Plumbing', hq_state: 'GA' }, contacts, baseConfig);
  assert.equal(inPool.outreach_ready, true);
  assert.ok(outsidePool.industry_score > 0);
  assert.equal(eleven.employee_fit.eligible, true);
  assert.ok(inPool.size_score > eleven.size_score);
  assert.equal(twenty.outreach_ready, false);
  assert.equal(twenty.employee_fit.reason, 'employee_count_20_or_more');
  assert.equal(unknown.outreach_ready, false);
  assert.equal(unknown.employee_fit.decision, 'needs_evidence');
});

test('a reachable FGA micro-business can qualify outside the configured industry without a contacts row', () => {
  const result = computeScore({
    tenant_id: FGA_TENANT_ID,
    lead_source: 'prospecting_agent',
    size: '1-5',
    email: 'owner@example.test',
    industry: 'Independent Retail',
    hq_state: 'GA',
  }, [], baseConfig);

  assert.equal(result.employee_fit.segment, 'estimated_sweet_spot_1_9');
  assert.equal(result.contact_quality_score, 4, 'lead-level email is grounded reachability evidence');
  assert.equal(result.outreach_ready, true, 'industry is a priority signal, not an exclusion gate');
});

test('FGA qualification uses the same threshold as restart and autosend while customer scoring stays unchanged', () => {
  const tenant = {
    config: {
      autosend_score_threshold: '60',
      scoring_rules: { tier_a: 70, tier_b: 50 },
    },
  };
  assert.deepStrictEqual(resolveScoringThresholds(tenant, true), {
    tierAThreshold: 60,
    tierBThreshold: 50,
  });
  assert.deepStrictEqual(resolveScoringThresholds(tenant, false), {
    tierAThreshold: 70,
    tierBThreshold: 50,
  });
});

test('FGA terminal, engaged, inbound, and customer-lifecycle rows can never be marked outreach-ready', () => {
  const qualified = withEmployeeProof(4, {
    lead_source: 'prospecting_agent',
    status: 'new_lead',
    lifecycle_stage: 'scored',
    email: 'owner@example.test',
    industry: 'Plumbing',
    hq_state: 'GA',
  });
  const disqualified = computeScore({ ...qualified, status: 'disqualified' }, contacts, baseConfig);
  const replied = computeScore({ ...qualified, status: 'replied' }, contacts, baseConfig);
  const inbound = computeScore({ ...qualified, lead_source: 'website_demo_request' }, contacts, baseConfig);
  const customer = computeScore({ ...qualified, lifecycle_stage: 'customer' }, contacts, baseConfig);

  for (const result of [disqualified, replied, inbound, customer]) {
    assert.equal(result.outreach_ready, false);
    assert.equal(result.recommendation, 'Not eligible for autonomous outreach');
    assert.ok(result.outreach_block_reason);
  }
  assert.equal(fgaScoringBlockReason(qualified), null);

  const customerConfig = {
    ...baseConfig,
    strictMicroBusiness: false,
    minEmployees: 20,
    maxEmployees: 150,
    targetIndustries: ['Manufacturing'],
    tierAThreshold: 60,
  };
  const customerLead = { employee_count_actual: 50, industry: 'Manufacturing', hq_state: 'GA' };
  assert.deepStrictEqual(
    computeScore({ ...customerLead, status: 'disqualified' }, contacts, customerConfig),
    computeScore({ ...customerLead, status: 'new_lead' }, contacts, customerConfig),
    'FGA status containment must not alter deployed customer-tenant scoring',
  );
});

test('score-version upgrades prioritize existing FGA 1-9 inventory and exclude unsafe or customer rows', () => {
  const stale = (id, extra = {}) => ({
    id,
    tenant_id: FGA_TENANT_ID,
    lead_source: 'prospecting_agent',
    email: `${id}@example.test`,
    size: '1-5',
    lead_score: 45,
    created_at: '2026-08-01T00:00:00.000Z',
    metadata: { score_breakdown: { score_version: 'wide-net-priority-v1' } },
    ...extra,
  });
  const selected = selectFgaScoreVersionUpgrades([
    stale('new-sweet', { created_at: '2026-09-11T00:00:00.000Z' }),
    stale('existing-accepted', { size: '10-19' }),
    stale('existing-sweet'),
    stale('current', { metadata: { score_breakdown: { score_version: SCORE_VERSION } } }),
    stale('customer', { tenant_id: 'customer-tenant' }),
    stale('too-large', { employee_count_actual: 20 }),
    stale('inbound', { lead_source: 'website_demo_request' }),
    stale('terminal', { status: 'disqualified' }),
    stale('customer-lifecycle', { lifecycle_stage: 'customer' }),
    stale('quarantined', { metadata: { intake_safety: { contact_allowed: false } } }),
  ], 10);

  assert.deepStrictEqual(selected.map((lead) => lead.id), [
    'existing-sweet',
    'existing-accepted',
    'new-sweet',
  ]);
});

test('customer scoring retains its previous employee range and vertical weighting', () => {
  const config = {
    ...baseConfig, strictMicroBusiness: false, minEmployees: 20, maxEmployees: 150,
    targetIndustries: ['Manufacturing', 'Marketing Agency'],
  };
  const manufacturing = computeScore({ employee_count_actual: 50, industry: 'Manufacturing', hq_state: 'GA' }, contacts, config);
  const marketing = computeScore({ employee_count_actual: 50, industry: 'Marketing Agency', hq_state: 'GA' }, contacts, config);
  assert.equal(manufacturing.size_score, 30);
  assert.equal(manufacturing.industry_score, 25);
  assert.equal(marketing.industry_score, 10);
  assert.equal(manufacturing.employee_fit, null);
});

test('only ready, never-contacted FGA prospects advance from scoring to outreach', () => {
  assert.equal(shouldHandoffToOutreach(
    FGA_TENANT_ID,
    { status: 'new_lead', lead_source: 'prospecting_agent' },
    { outreach_ready: true },
  ), true);
  assert.equal(shouldHandoffToOutreach(
    FGA_TENANT_ID,
    { status: 'contacted', lead_source: 'prospecting_agent' },
    { outreach_ready: true },
  ), false);
  assert.equal(shouldHandoffToOutreach(
    FGA_TENANT_ID,
    { status: 'new_lead', lead_source: 'prospecting_agent' },
    { outreach_ready: false },
  ), false);
  assert.equal(shouldHandoffToOutreach(
    'customer-tenant',
    { status: 'new_lead', lead_source: 'prospecting_agent' },
    { outreach_ready: true },
  ), false);
  assert.equal(shouldHandoffToOutreach(
    FGA_TENANT_ID,
    { status: 'new_lead', lead_source: 'website_demo_request' },
    { outreach_ready: true },
  ), false, 'an inbound demo request is never handed to cold outreach');
  assert.equal(shouldHandoffToOutreach(
    FGA_TENANT_ID,
    { status: 'new_lead', lead_source: 'prospecting_agent' },
    { outreach_ready: true },
    { skipOutreachHandoff: true },
  ), false, 'operator-controlled rescores can suppress all drafting handoffs');
});

test('FGA explanation is deterministic and bypasses the serial model bottleneck', () => {
  const scoring = computeScore(
    withEmployeeProof(4, { industry: 'Plumbing', hq_state: 'GA' }),
    contacts,
    baseConfig,
  );
  const explanation = deterministicScoreExplanation(scoring);
  assert.match(explanation, new RegExp(`Tier ${scoring.tier} \\(${scoring.total_score}/100\\)`));
  assert.match(explanation, /Size fit/);

  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'worker', 'agents', 'scoring.js'),
    'utf8',
  );
  assert.match(source, /strictMicroBusiness\s*\? deterministicScoreExplanation\(scoring\)/);
  assert.match(source, /: await generateScoreExplanation\(tenant, lead, scoring\)/);
  assert.match(
    source,
    /if \(!strictMicroBusiness && !fetchErr && !onlyScoreVersionMismatch && remaining > 0\)/,
    'unchanged FGA current-version scores must not enter the recurring generic rescore loop',
  );
});
