'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FGA_TENANT_ID } = require('../../core/config');
const {
  summarizeDeliveryLifecycle,
  readDeliveryLifecycle,
} = require('../../core/revenue/delivery-lifecycle');

test('acceptance is reconciled into delivered, delayed, suppressed and unknown without double counting', () => {
  const summary = summarizeDeliveryLifecycle(
    ['accepted-1', 'accepted-2', 'accepted-3', 'accepted-4', 'accepted-4'],
    [
      { provider_email_id: 'accepted-1', event: 'delayed' },
      { provider_email_id: 'accepted-1', event: 'delivered' },
      { provider_email_id: 'accepted-1', event: 'opened' },
      { provider_email_id: 'accepted-2', event: 'email.delivery_delayed' },
      { provider_email_id: 'accepted-3', event: 'delivered' },
      { provider_email_id: 'accepted-3', event: 'suppressed' },
      { provider_email_id: 'outside-cohort', event: 'complained' },
    ],
  );

  assert.deepEqual(summary, {
    available: true,
    accepted: 4,
    observed: 3,
    terminal: 2,
    delivered: 1,
    delayed: 1,
    sent: 0,
    suppressed: 1,
    bounced: 0,
    complained: 0,
    failed: 0,
    unknown: 1,
    pending: 2,
    evidence_complete: false,
    reason: null,
  });
});

test('negative terminal evidence outranks earlier delivery evidence', () => {
  const summary = summarizeDeliveryLifecycle(['one', 'two'], [
    { provider_email_id: 'one', event: 'delivered' },
    { provider_email_id: 'one', event: 'complained' },
    { provider_email_id: 'two', event: 'opened' },
  ]);
  assert.equal(summary.complained, 1);
  assert.equal(summary.delivered, 1);
  assert.equal(summary.terminal, 2);
  assert.equal(summary.pending, 0);
  assert.equal(summary.evidence_complete, true);
});

test('reader is exact-FGA, returns aggregates only, and exposes read failure as unavailable', async () => {
  const observed = { filters: {} };
  const query = {
    select() { return query; },
    eq(key, value) { observed.filters[key] = value; return query; },
    in(key, value) { observed.filters[key] = value; return query; },
    limit() { return query; },
    then(resolve) {
      return Promise.resolve({
        data: [{ provider_email_id: 'provider-a', event: 'delivered' }],
        error: null,
      }).then(resolve);
    },
  };
  const db = { from(table) { observed.table = table; return query; } };
  const summary = await readDeliveryLifecycle(db, {
    starts: [{ provider_id: 'provider-a' }, { provider_id: 'provider-b' }],
  });

  assert.equal(observed.table, 'email_events');
  assert.equal(observed.filters.tenant_id, FGA_TENANT_ID);
  assert.equal(observed.filters.provider, 'resend');
  assert.deepEqual(observed.filters.provider_email_id, ['provider-a', 'provider-b']);
  assert.equal(summary.delivered, 1);
  assert.equal(summary.unknown, 1);
  assert.equal(JSON.stringify(summary).includes('provider-a'), false);

  const failedQuery = {
    select() { return failedQuery; },
    eq() { return failedQuery; },
    in() { return failedQuery; },
    limit() { return failedQuery; },
    then(resolve) {
      return Promise.resolve({ data: null, error: { message: 'database offline' } }).then(resolve);
    },
  };
  const unavailable = await readDeliveryLifecycle(
    { from() { return failedQuery; } },
    { starts: [{ provider_id: 'provider-a' }] },
  );
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.accepted, 1);
  assert.equal(unavailable.delivered, null);
  assert.equal(unavailable.reason, 'provider_lifecycle_read_failed');
});

test('reader rejects non-FGA tenant selection without issuing a database read', async () => {
  let reads = 0;
  const summary = await readDeliveryLifecycle({ from() { reads += 1; } }, {
    starts: [{ provider_id: 'provider-a' }],
    tenantId: 'another-tenant',
  });
  assert.equal(reads, 0);
  assert.equal(summary.available, false);
  assert.equal(summary.reason, 'non_fga_tenant_rejected');
});
