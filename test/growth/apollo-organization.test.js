'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  enrichOrganizationHeadcount,
  normalizeDomain,
} = require('../../integrations/apollo-organization');

function clientWith(organization) {
  return {
    async get(_url, request) {
      assert.equal(request.headers['x-api-key'], 'test-key');
      return { status: 200, data: { organization } };
    },
  };
}

test('Apollo organization evidence is minimized, domain-matched, and labeled as an estimate', async () => {
  const result = await enrichOrganizationHeadcount({
    domain: 'https://www.example.com/about',
    name: 'Example',
  }, {
    apiKey: 'test-key',
    httpClient: clientWith({
      id: 'org_123',
      primary_domain: 'example.com',
      estimated_num_employees: 7,
      name: 'must not escape the adapter',
    }),
  });

  assert.deepEqual(result, {
    ok: true,
    status: 200,
    evidence: {
      count: 7,
      source: 'apollo:organization:org_123',
      confidence: 0.85,
      method: 'provider_estimate',
      provider: 'apollo',
      domain_match: true,
    },
  });
  assert.equal(JSON.stringify(result).includes('must not escape'), false);
});

test('Apollo evidence fails closed on domain mismatch and missing counts', async () => {
  const mismatch = await enrichOrganizationHeadcount({ domain: 'example.com' }, {
    apiKey: 'test-key',
    httpClient: clientWith({
      id: 'org_123',
      primary_domain: 'different.example',
      estimated_num_employees: 4,
    }),
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reason, 'domain_mismatch');

  const missing = await enrichOrganizationHeadcount({ domain: 'example.com' }, {
    apiKey: 'test-key',
    httpClient: clientWith({ id: 'org_123', primary_domain: 'example.com' }),
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'employee_count_unavailable');
});

test('Apollo domain normalization rejects path and www drift', () => {
  assert.equal(normalizeDomain('https://www.Example.com/path'), 'example.com');
  assert.equal(normalizeDomain('www.example.com/people'), 'example.com');
  assert.equal(normalizeDomain(null), null);
});
