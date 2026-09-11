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
  shouldHandoffToOutreach,
} = require('../../worker/agents/scoring')._test;

const contacts = [{ role_in_buying: 'decision_maker' }];
const baseConfig = {
  targetStates: ['GA'], targetIndustries: ['Plumbing'],
  minEmployees: 1, maxEmployees: 9,
  tierAThreshold: 60, tierBThreshold: 45,
  strictMicroBusiness: true,
};
const withEmployeeProof = (count, extra = {}) => ({
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
});
