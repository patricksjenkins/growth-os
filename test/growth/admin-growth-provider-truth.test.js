'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  summarizeContactRecovery,
  summarizeGrowthUsage,
} = require('../../api/routes/admin-growth')._test;

test('Growth evidence readout surfaces a rejected headcount provider as visible operating debt', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../api/routes/admin-growth.js'), 'utf8');
  const evidenceSource = fs.readFileSync(path.join(__dirname, '../../core/growth/evidence.js'), 'utf8');
  assert.match(source, /contains\('payload', \{ evidence_recovery: true \}\)/);
  assert.match(source, /growthReadiness\(\{/);
  assert.match(source, /employeeProviderRejected,/);
  assert.match(evidenceSource, /employeeProviderRejected && 'employee_evidence_provider_rejected'/);
  assert.match(source, /credential_accepted: providerVerified \? true : \(employeeProviderRejected \? false : null\)/);
  assert.match(source, /employee_evidence_provider_receipts/);
  assert.match(source, /activeEmployeeProvider/);
});

test('Growth workload usage is aggregate-only and unavailable never becomes a confident zero', () => {
  assert.deepEqual(summarizeGrowthUsage(null, 'usage read failed'), {
    available: false,
    provider_calls_24h: null,
    estimated_cost_usd_24h: null,
    by_provider: {},
    reason: 'usage read failed',
  });
  assert.deepEqual(summarizeGrowthUsage([
    { provider: 'anthropic', estimated_cost_usd: 0.125 },
    { provider: 'serper', estimated_cost_usd: 0.001 },
    { provider: 'anthropic', estimated_cost_usd: 0.25 },
  ]), {
    available: true,
    provider_calls_24h: 3,
    estimated_cost_usd_24h: 0.376,
    by_provider: { anthropic: 2, serper: 1 },
    reason: null,
  });
});

test('contact recovery is reported separately with aggregate, privacy-safe receipts', () => {
  const rows = [
    {
      email: 'one@example.com', growth_evidence_status: 'contact_only', growth_evidence_attempts: 1,
      metadata: { contact_email_evidence: { source: 'facebook_about' } },
    },
    {
      email: 'two@example.com', growth_evidence_status: 'complete', growth_evidence_attempts: 1,
      metadata: { contact_email_evidence: { source: 'owned_website' } },
    },
    { email: null, growth_evidence_status: 'incomplete', growth_evidence_attempts: 4, metadata: {} },
    { email: null, growth_evidence_status: 'failed', growth_evidence_attempts: 5, metadata: {} },
  ];
  const summary = summarizeContactRecovery(rows, {
    status: 'completed', completed_at: '2026-09-11T22:30:00.000Z',
    result: {
      processed: [{}, {}, {}], contact_qualified: 2,
      contact_source_receipts: {
        owned_site_attempted: 1, owned_site_email_found: 0,
        facebook_about_attempted: 2, facebook_about_email_found: 1,
      },
    },
  });

  assert.deepEqual(summary, {
    prospects_with_email: 2,
    prospects_missing_email: 2,
    source_backed_email_records: 2,
    recovery_candidates_under_attempt_cap: 2,
    latest_run: {
      status: 'completed', completed_at: '2026-09-11T22:30:00.000Z',
      examined: 3, contact_qualified: 2,
      source_receipts: {
        owned_site_attempted: 1, owned_site_email_found: 0,
        facebook_about_attempted: 2, facebook_about_email_found: 1,
      },
    },
  });
  assert.equal(JSON.stringify(summary).includes('@example.com'), false,
    'aggregate evidence must never disclose a recovered address');
});
