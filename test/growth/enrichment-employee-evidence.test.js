'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { FGA_TENANT_ID } = require('../../core/config');
const enrichment = require('../../worker/agents/enrichment');

const { acceptedEmployeeEvidence, providerDomainAfterResearch } = enrichment._test;

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
  assert.equal(acceptedEmployeeEvidence({
    employee_count: 7,
    employee_count_source: 'https://invented.example/team',
    employee_count_confidence: 0.9,
  }, FGA_TENANT_ID, ['https://actual.example/team']), null,
  'an extractor cannot invent a source URL outside the supplied result set');
});

test('employee evidence extraction cannot alter a customer tenant', () => {
  assert.equal(acceptedEmployeeEvidence({
    employee_count: 3,
    employee_count_source: 'public business profile',
    employee_count_confidence: 1,
  }, '00000000-0000-0000-0000-000000000999'), null);
});

test('FGA retries provider evidence with a domain discovered during public research', () => {
  assert.equal(providerDomainAfterResearch(
    FGA_TENANT_ID,
    'domain_missing',
    null,
    { website: 'https://www.Example.com/contact' },
  ), 'example.com');
  assert.equal(providerDomainAfterResearch(
    '00000000-0000-0000-0000-000000000999',
    'domain_missing',
    null,
    { website: 'https://example.com' },
  ), null, 'customer enrichment is unchanged');
  assert.equal(providerDomainAfterResearch(
    FGA_TENANT_ID,
    'credential_rejected',
    null,
    { website: 'https://example.com' },
  ), null, 'an attempted provider lookup is never doubled');
  assert.equal(providerDomainAfterResearch(
    FGA_TENANT_ID,
    'domain_missing',
    { count: 7 },
    { website: 'https://example.com' },
  ), null, 'existing evidence is never replaced');
});

test('evidence recovery reports contact and employee proof as separate facts', () => {
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../../worker/agents/enrichment.js'),
    'utf8',
  );
  assert.match(source, /contact_qualified: qualified/);
  assert.match(source, /employee_evidence_verified: employeeEvidenceVerified/);
  assert.match(source, /growth_evidence_complete: growthEvidenceComplete/);
  assert.match(source, /evidenceRecovery \? \{\} : \{ company: lead\.company_name \}/,
    'evidence-recovery job results must not persist company names');
  assert.match(source, /order\('growth_evidence_attempts', \{ ascending: true/,
    'recovery must rotate through least-attempted leads before retrying the same five');
  assert.match(source, /suppressOutreachEnqueue: true/,
    'evidence recovery must never enqueue outreach as a side effect');
});
