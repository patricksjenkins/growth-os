'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  acceptExactEmployeeEvidence,
  acceptProviderEmployeeEvidence,
  evidenceMatchesLead,
} = require('../../core/growth/employee-evidence');

test('search evidence requires an exact count, confidence, and a supplied source URL', () => {
  const source = 'https://example.com/team';
  assert.deepEqual(acceptExactEmployeeEvidence({
    count: 7, source, confidence: 0.9, allowedSourceUrls: [source],
  }), { count: 7, source, confidence: 0.9 });
  assert.equal(acceptExactEmployeeEvidence({ count: 7, source, confidence: 0.79, allowedSourceUrls: [source] }), null);
  assert.equal(acceptExactEmployeeEvidence({ count: 7, source: 'https://invented.example', confidence: 1, allowedSourceUrls: [source] }), null);
  assert.equal(acceptExactEmployeeEvidence({ count: '1-9', source, confidence: 1, allowedSourceUrls: [source] }), null);
});

test('approved provider estimates require provider-specific source and exact domain match', () => {
  assert.deepEqual(acceptProviderEmployeeEvidence({
    count: 8,
    source: 'apify:organization:harvestapi-linkedin-company:123',
    confidence: 0.85,
    provider: 'apify',
    domainMatched: true,
  }), {
    count: 8,
    source: 'apify:organization:harvestapi-linkedin-company:123',
    confidence: 0.85,
    method: 'provider_estimate',
    provider: 'apify',
    domain_match: true,
  });
  assert.equal(acceptProviderEmployeeEvidence({
    count: 8,
    source: 'apify:organization:harvestapi-linkedin-company:123',
    confidence: 0.85,
    provider: 'apify',
    domainMatched: false,
  }), null);
  assert.equal(acceptProviderEmployeeEvidence({
    count: 8,
    source: 'apollo:organization:123',
    confidence: 0.85,
    provider: 'apify',
    domainMatched: true,
  }), null);
});

test('lead proof must match the stored exact employee count', () => {
  const lead = {
    employee_count_actual: 4,
    metadata: { employee_count_evidence: { count: 4, source: 'public registry', confidence: 0.95 } },
  };
  assert.equal(evidenceMatchesLead(lead).count, 4);
  assert.equal(evidenceMatchesLead({ ...lead, employee_count_actual: 5 }), null);
});
