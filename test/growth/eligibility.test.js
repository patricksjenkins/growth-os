'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  EXCLUSIVE_EMPLOYEE_CEILING,
  ICP_VERSION,
  employeeEvidence,
  evaluateEmployeeFit,
} = require('../../core/growth/eligibility');

test('FGA ICP is industry-neutral with 1-9 preferred and 10-19 accepted', () => {
  assert.equal(EXCLUSIVE_EMPLOYEE_CEILING, 20);
  for (const industry of ['Plumbing', 'Law Firm', 'Salon', 'Bookkeeping', 'Something New']) {
    const result = evaluateEmployeeFit({
      industry,
      employee_count_actual: 9,
      metadata: { employee_count_evidence: { count: 9, source: 'public registry', confidence: 0.9 } },
    });
    assert.equal(result.eligible, true);
    assert.equal(result.icp_version, ICP_VERSION);
  }
});

test('11 employees remains eligible while 20 is outside the ceiling', () => {
  const eleven = evaluateEmployeeFit({ employee_count_actual: 11 });
  assert.equal(eleven.eligible, true);
  assert.equal(eleven.segment, 'estimated_small_business_10_19');
  const result = evaluateEmployeeFit({ employee_count_actual: 20 });
  assert.equal(result.eligible, false);
  assert.equal(result.decision, 'ineligible');
  assert.equal(result.reason, 'employee_count_20_or_more');
});

test('source-backed employee_count_actual is authoritative over legacy fields', () => {
  const evidence = employeeEvidence({
    employee_count_actual: 7,
    employee_count: 15,
    size: '20-50',
    metadata: { employee_count_evidence: { count: 7, source: 'public registry', confidence: 0.9 } },
  });
  assert.equal(evidence.count, 7);
  assert.equal(evidence.source, 'employee_count_evidence');
  assert.equal(evidence.confirmed, true);
});

test('historical exact counts below 20 are eligible as estimates, never mislabeled verified', () => {
  const result = evaluateEmployeeFit({ employee_count_actual: 7 });
  assert.equal(result.decision, 'eligible');
  assert.equal(result.reason, 'estimated_small_business');
  assert.equal(result.segment, 'estimated_sweet_spot_1_9');
});

test('unknown or crossing ranges return to evidence gathering instead of sending', () => {
  assert.equal(evaluateEmployeeFit({}).decision, 'needs_evidence');
  assert.equal(evaluateEmployeeFit({ size: '10-50' }).reason, 'employee_range_crosses_ceiling');
  assert.equal(evaluateEmployeeFit({ size: '1-9' }).reason, 'estimated_small_business');
});

test('a legacy under-10 size band is an eligible estimate and stays labeled estimated', () => {
  const verdict = evaluateEmployeeFit({ size: '1-5' });
  assert.equal(verdict.decision, 'eligible');
  assert.equal(verdict.reason, 'estimated_small_business');
  assert.equal(verdict.segment, 'estimated_sweet_spot_1_9');
});

test('a domain-matched provider estimate is eligible but remains labeled as an estimate', () => {
  const result = evaluateEmployeeFit({
    employee_count_actual: 9,
    metadata: {
      employee_count_evidence: {
        count: 9,
        source: 'apollo:organization:org_123',
        confidence: 0.85,
        method: 'provider_estimate',
        provider: 'apollo',
        domain_match: true,
      },
    },
  });
  assert.equal(result.eligible, true);
  assert.equal(result.reason, 'provider_estimated_sweet_spot');
  assert.equal(result.evidence.proof.method, 'provider_estimate');
});
