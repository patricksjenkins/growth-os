'use strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeScore } = require('../../worker/agents/scoring')._test;

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

test('FGA scoring is industry-neutral but requires confirmed 1-9 employee fit', () => {
  const inPool = computeScore(withEmployeeProof(4, { industry: 'Plumbing', hq_state: 'GA' }), contacts, baseConfig);
  const outsidePool = computeScore(withEmployeeProof(4, { industry: 'Florist', hq_state: 'GA' }), contacts, baseConfig);
  const ten = computeScore({ employee_count_actual: 10, industry: 'Plumbing', hq_state: 'GA' }, contacts, baseConfig);
  const unknown = computeScore({ industry: 'Plumbing', hq_state: 'GA' }, contacts, baseConfig);
  assert.equal(inPool.outreach_ready, true);
  assert.ok(outsidePool.industry_score > 0);
  assert.equal(ten.outreach_ready, false);
  assert.equal(ten.employee_fit.reason, 'employee_count_10_or_more');
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
