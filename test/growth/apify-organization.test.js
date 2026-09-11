'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  enrichOrganizationHeadcountViaApify,
  companyLinkedinUrl,
} = require('../../integrations/apify-organization');

function clientWith(rows, inspect = () => {}) {
  return {
    async post(url, input, request) {
      inspect({ url, input, request });
      return { status: 200, data: rows };
    },
  };
}

test('Apify company evidence is minimized, charge-capped, and exact-domain matched', async () => {
  const result = await enrichOrganizationHeadcountViaApify({
    domain: 'https://www.example.com/about',
    name: 'Example Co',
    linkedinUrl: 'https://linkedin.com/company/example-co/',
  }, {
    apiToken: 'test-token',
    httpClient: clientWith([{
      id: '12345',
      name: 'must not escape the adapter',
      website: 'https://example.com',
      employeeCount: 7,
      peopleStats: { private: 'must not escape either' },
    }], ({ input, request }) => {
      assert.deepEqual(input, { companies: ['https://www.linkedin.com/company/example-co/'] });
      assert.equal(request.params.maxItems, 1);
      assert.equal(request.params.maxTotalChargeUsd, 0.01);
      assert.equal(request.params.token, 'test-token');
    }),
  });

  assert.deepEqual(result, {
    ok: true,
    status: 200,
    attempted: true,
    lookup: 'company_url',
    provider: 'apify',
    evidence: {
      count: 7,
      source: 'apify:organization:harvestapi-linkedin-company:12345',
      confidence: 0.85,
      method: 'provider_estimate',
      provider: 'apify',
      domain_match: true,
    },
  });
  assert.equal(JSON.stringify(result).includes('must not escape'), false);
});

test('name discovery cannot authorize evidence without exactly one matching domain', async () => {
  const mismatch = await enrichOrganizationHeadcountViaApify({
    domain: 'example.com', name: 'Example Co',
  }, {
    apiToken: 'test-token',
    httpClient: clientWith([{
      id: 'different', website: 'https://different.example', employeeCount: 4,
    }], ({ input, request }) => {
      assert.deepEqual(input, { searches: ['Example Co'] });
      assert.equal(request.params.maxItems, 3);
      assert.equal(request.params.maxTotalChargeUsd, 0.02);
    }),
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reason, 'domain_mismatch');

  const ambiguous = await enrichOrganizationHeadcountViaApify({
    domain: 'example.com', name: 'Example Co',
  }, {
    apiToken: 'test-token',
    httpClient: clientWith([
      { id: 'one', website: 'https://example.com', employeeCount: 4 },
      { id: 'two', website: 'https://www.example.com', employeeCount: 5 },
    ]),
  });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.reason, 'ambiguous_domain_match');
});

test('Apify evidence fails closed on missing count, identifier, and spend limits', async () => {
  const missingCount = await enrichOrganizationHeadcountViaApify({
    domain: 'example.com', name: 'Example Co',
  }, {
    apiToken: 'test-token',
    httpClient: clientWith([{ id: '123', website: 'example.com' }]),
  });
  assert.equal(missingCount.reason, 'employee_count_unavailable');

  const missingId = await enrichOrganizationHeadcountViaApify({
    domain: 'example.com', name: 'Example Co',
  }, {
    apiToken: 'test-token',
    httpClient: clientWith([{ website: 'example.com', employeeCount: 7 }]),
  });
  assert.equal(missingId.reason, 'employee_count_unavailable');

  const spendLimit = await enrichOrganizationHeadcountViaApify({
    domain: 'example.com', name: 'Example Co',
  }, {
    apiToken: 'test-token',
    httpClient: { async post() { const error = new Error('do not expose'); error.response = { status: 402 }; throw error; } },
  });
  assert.deepEqual(spendLimit, {
    ok: false, reason: 'spend_limit_reached', retryable: false, status: 402, attempted: true,
  });
});

test('only public LinkedIn company URLs are accepted as direct identifiers', () => {
  assert.equal(
    companyLinkedinUrl('linkedin.com/company/Example-Co'),
    'https://www.linkedin.com/company/Example-Co/',
  );
  assert.equal(companyLinkedinUrl('https://www.linkedin.com/in/person-name'), null);
  assert.equal(companyLinkedinUrl('https://evil.example/company/example'), null);
  assert.equal(companyLinkedinUrl(null), null);
});
