'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { FGA_TENANT_ID } = require('../../core/config');
const {
  normalizeProviderState,
  reconciliationEventId,
  reconcileResendLifecycle,
} = require('../../core/revenue/resend-lifecycle-reconciliation');

function database({ existingEvents = [], activeEnrollments = [] } = {}) {
  const calls = [];
  const db = {
    calls,
    from(table) {
      const state = { table, op: 'select', payload: null, options: null, filters: [] };
      const builder = {
        select() { state.op = state.op === 'select' ? 'select' : state.op; return builder; },
        upsert(payload, options) { state.op = 'upsert'; state.payload = payload; state.options = options; return builder; },
        update(payload) { state.op = 'update'; state.payload = payload; return builder; },
        insert(payload) { state.op = 'insert'; state.payload = payload; return builder; },
        eq(column, value) { state.filters.push(['eq', column, value]); return builder; },
        in(column, value) { state.filters.push(['in', column, value]); return builder; },
        limit() { return builder; },
        maybeSingle() { return builder; },
        then(resolve, reject) {
          calls.push({ ...state, filters: [...state.filters] });
          let data = null;
          if (state.table === 'email_events' && state.op === 'select') data = existingEvents;
          if (state.table === 'drip_enrollments' && state.op === 'select') data = activeEnrollments;
          if (state.table === 'growth_events' && state.op === 'upsert') data = { id: 'growth-event' };
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
  return db;
}

function start(overrides = {}) {
  return {
    lead_id: 'lead-a',
    provider_id: 'provider-a',
    recipient: 'prospect@example.com',
    sent_at: '2026-09-11T12:00:00.000Z',
    ...overrides,
  };
}

test('normalizes provider states without treating delayed mail as delivered', () => {
  assert.deepEqual(normalizeProviderState('delivery_delayed'), {
    event: 'delayed', terminal: false, delivered: false, suppress: false,
  });
  assert.equal(normalizeProviderState('opened').delivered, true);
  assert.equal(normalizeProviderState('clicked').delivered, true);
  assert.equal(normalizeProviderState('suppressed').suppress, true);
  assert.equal(normalizeProviderState('queued').event, null);
  assert.equal(
    reconciliationEventId('provider-a', 'suppressed'),
    'resend-api-reconcile:provider-a:suppressed',
  );
});

test('provider-confirmed suppression is recorded and stops only the exact FGA lead', async () => {
  const db = database({ activeEnrollments: [{ id: 'enrollment-a' }] });
  const result = await reconcileResendLifecycle(db, {
    starts: [start()],
    now: new Date('2026-09-11T13:00:00.000Z'),
    retrieveEmail: async () => ({
      last_event: 'suppressed', recipient: 'prospect@example.com',
      occurred_at: '2026-09-11T12:00:00.000Z',
    }),
  });

  assert.deepEqual(result, {
    eligible: 1, checked: 1, repaired: 1, delivered_proof: 0,
    suppressed: 1, delayed: 0, pending: 0, errors: 0,
    sends_messages: false,
  });
  const event = db.calls.find((call) => call.table === 'email_events' && call.op === 'upsert');
  assert.equal(event.payload.tenant_id, FGA_TENANT_ID);
  assert.equal(event.payload.event, 'suppressed');
  assert.equal(event.options.onConflict, 'provider,provider_event_id');

  const suppression = db.calls.find((call) => call.table === 'drip_suppressions' && call.op === 'upsert');
  assert.equal(suppression.payload.tenant_id, FGA_TENANT_ID);
  const leadStop = db.calls.find((call) => call.table === 'leads' && call.op === 'update');
  assert.ok(leadStop.filters.some((f) => f[1] === 'tenant_id' && f[2] === FGA_TENANT_ID));
  assert.ok(leadStop.filters.some((f) => f[1] === 'id' && f[2] === 'lead-a'));
  const enrollmentStop = db.calls.find((call) => call.table === 'drip_enrollments' && call.op === 'update');
  assert.ok(enrollmentStop.filters.some((f) => f[1] === 'tenant_id' && f[2] === FGA_TENANT_ID));
  const scheduledSendStop = db.calls.find((call) => call.table === 'drip_sends' && call.op === 'update');
  assert.ok(scheduledSendStop.filters.some((f) => f[1] === 'tenant_id' && f[2] === FGA_TENANT_ID));
  assert.equal(JSON.stringify(result).includes('prospect@example.com'), false);
  assert.equal(JSON.stringify(result).includes('provider-a'), false);
});

test('existing terminal evidence makes the repair idempotent and avoids a provider read', async () => {
  const db = database({ existingEvents: [{ provider_email_id: 'provider-a', event: 'delivered' }] });
  let reads = 0;
  const result = await reconcileResendLifecycle(db, {
    starts: [start()],
    now: new Date('2026-09-11T13:00:00.000Z'),
    retrieveEmail: async () => { reads++; return { last_event: 'suppressed' }; },
  });
  assert.equal(reads, 0);
  assert.equal(result.checked, 0);
  assert.equal(result.repaired, 0);
  assert.equal(db.calls.some((call) => call.op === 'upsert'), false);
});

test('a delayed provider state is evidence but never a suppression', async () => {
  const db = database();
  const result = await reconcileResendLifecycle(db, {
    starts: [start()],
    now: new Date('2026-09-11T13:00:00.000Z'),
    retrieveEmail: async () => ({ last_event: 'delivery_delayed' }),
  });
  assert.equal(result.delayed, 1);
  assert.equal(result.suppressed, 0);
  assert.equal(db.calls.some((call) => call.table === 'drip_suppressions'), false);
  const event = db.calls.find((call) => call.table === 'email_events' && call.op === 'upsert');
  assert.equal(event.payload.event, 'delayed');
});

test('an unchanged delayed state is rechecked without manufacturing another repair', async () => {
  const db = database({
    existingEvents: [{ provider_email_id: 'provider-a', event: 'delayed' }],
  });
  const result = await reconcileResendLifecycle(db, {
    starts: [start()],
    now: new Date('2026-09-11T13:00:00.000Z'),
    retrieveEmail: async () => ({ last_event: 'delivery_delayed' }),
  });
  assert.equal(result.checked, 1);
  assert.equal(result.delayed, 1);
  assert.equal(result.repaired, 0);
  assert.equal(db.calls.some((call) => call.op === 'upsert'), false);
});

test('recipient mismatch fails closed before suppression or lead mutation', async () => {
  const db = database();
  const result = await reconcileResendLifecycle(db, {
    starts: [start()],
    now: new Date('2026-09-11T13:00:00.000Z'),
    retrieveEmail: async () => ({
      last_event: 'suppressed', recipient: 'different@example.com',
    }),
  });
  assert.equal(result.errors, 1);
  assert.equal(result.repaired, 0);
  assert.equal(result.suppressed, 0);
  assert.equal(db.calls.some((call) => call.table === 'drip_suppressions'), false);
  assert.equal(db.calls.some((call) => call.table === 'leads' && call.op === 'update'), false);
});

test('provider errors surface as aggregate evidence failure without PII', async () => {
  const db = database();
  const result = await reconcileResendLifecycle(db, {
    starts: [start()],
    now: new Date('2026-09-11T13:00:00.000Z'),
    retrieveEmail: async () => { throw new Error('secret detail prospect@example.com'); },
  });
  assert.equal(result.errors, 1);
  assert.equal(result.repaired, 0);
  assert.equal(JSON.stringify(result).includes('secret detail'), false);
  assert.equal(JSON.stringify(result).includes('prospect@example.com'), false);
});
