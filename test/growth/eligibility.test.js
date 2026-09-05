'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  EXCLUSIVE_EMPLOYEE_CEILING,
  ICP_VERSION,
  employeeEvidence,
  evaluateEmployeeFit,
} = require('../../core/growth/eligibility');

test('FGA ICP is industry-neutral and strictly fewer than 10 employees', () => {
  assert.equal(EXCLUSIVE_EMPLOYEE_CEILING, 10);
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

test('10 employees is outside the exclusive ceiling', () => {
  const result = evaluateEmployeeFit({ employee_count_actual: 10 });
  assert.equal(result.eligible, false);
  assert.equal(result.decision, 'ineligible');
  assert.equal(result.reason, 'employee_count_10_or_more');
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

test('historical exact counts without source proof cannot authorize outreach', () => {
  const result = evaluateEmployeeFit({ employee_count_actual: 7 });
  assert.equal(result.decision, 'needs_evidence');
  assert.equal(result.reason, 'employee_count_provenance_missing');
});

test('unknown or crossing ranges return to evidence gathering instead of sending', () => {
  assert.equal(evaluateEmployeeFit({}).decision, 'needs_evidence');
  assert.equal(evaluateEmployeeFit({ size: '5-15' }).reason, 'employee_range_crosses_ceiling');
  assert.equal(evaluateEmployeeFit({ size: '1-9' }).reason, 'employee_range_unverified');
});

test('a legacy under-10 size band is research input, not autonomous-send authority', () => {
  const verdict = evaluateEmployeeFit({ size: '1-5' });
  assert.equal(verdict.decision, 'needs_evidence');
  assert.equal(verdict.reason, 'employee_range_unverified');
});
