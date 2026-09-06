'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { FGA_TENANT_ID } = require('../../core/config');
const enrichment = require('../../worker/agents/enrichment');

const { acceptedEmployeeEvidence } = enrichment._test;

test('FGA accepts only explicit, high-confidence, source-backed exact headcount', () => {
  assert.deepEqual(acceptedEmployeeEvidence({
    employee_count: 7,
    employee_count_source: 'public business profile',
    employee_count_confidence: 0.9,
  }, FGA_TENANT_ID), {
    count: 7,
    source: 'public business profile',
    confidence: 0.9,
  });
  assert.equal(acceptedEmployeeEvidence({
    employee_count: 7,
    employee_count_source: null,
    employee_count_confidence: 0.9,
  }, FGA_TENANT_ID), null);
  assert.equal(acceptedEmployeeEvidence({
    employee_count: 7,
    employee_count_source: 'guess',
    employee_count_confidence: 0.7,
  }, FGA_TENANT_ID), null);
});

test('employee evidence extraction cannot alter a customer tenant', () => {
  assert.equal(acceptedEmployeeEvidence({
    employee_count: 3,
    employee_count_source: 'public business profile',
    employee_count_confidence: 1,
  }, '00000000-0000-0000-0000-000000000999'), null);
});
