'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';

const {
  SUPERSEDED_REASON,
  deliveredEvidence,
  planRestartReceiptReconciliation,
  reconcileRestartReceipts,
} = require('../../core/growth/restart-receipts');
const { FGA_TENANT_ID } = require('../../core/config');

const delivered = (id, leadId, at = '2026-09-11T14:00:00Z') => ({
  id,
  lead_id: leadId,
  sequence_status: 'sent',
  metadata: { delivered: { at, provider_id: `provider-${id}` } },
});

test('only an exact provider-backed bound sequence repairs a missing sent receipt', () => {
  const candidate = {
    id: 'old', batch_id: 'batch-old', lead_id: 'lead-a',
    authorized_at: '2026-09-11T12:00:00Z', first_touch_sequence_id: 'seq-a',
  };
  assert.deepEqual(planRestartReceiptReconciliation({
    unconsumed: [candidate],
    sequences: [delivered('seq-a', 'lead-a')],
  }), [{
    type: 'consume_bound_receipt', candidateId: 'old', batchId: 'batch-old',
    leadId: 'lead-a', sequenceId: 'seq-a', sentAt: '2026-09-11T14:00:00Z',
  }]);

  assert.equal(deliveredEvidence({
    ...delivered('seq-a', 'lead-a'),
    metadata: { delivered: { at: '2026-09-11T14:00:00Z' } },
  }), null, 'a sent label without a provider id is not proof');
  assert.deepEqual(planRestartReceiptReconciliation({
    unconsumed: [candidate],
    sequences: [delivered('seq-a', 'different-lead')],
  }), [], 'cross-lead evidence cannot consume an authorization');
});

test('a superseded authorization is excluded only after a later authorized provider send', () => {
  const stale = {
    id: 'stale', batch_id: 'batch-old', lead_id: 'lead-a', evidence: { priority_score: 1 },
    authorized_at: '2026-09-10T12:00:00Z', first_touch_sequence_id: 'seq-old',
  };
  const replacement = {
    id: 'replacement', batch_id: 'batch-new', lead_id: 'lead-a',
    authorized_at: '2026-09-11T12:00:00Z', first_touch_sequence_id: 'seq-new',
    first_touch_sent_at: '2026-09-11T14:00:00Z',
  };
  const actions = planRestartReceiptReconciliation({
    unconsumed: [stale], consumed: [replacement],
    sequences: [
      { id: 'seq-old', lead_id: 'lead-a', sequence_status: 'superseded', metadata: {} },
      delivered('seq-new', 'lead-a'),
    ],
  });
  assert.equal(actions.length, 1);
  assert.deepEqual(actions[0], {
    type: 'exclude_superseded_authorization',
    candidateId: 'stale', batchId: 'batch-old', leadId: 'lead-a', sequenceId: 'seq-old',
    replacementCandidateId: 'replacement', replacementSequenceId: 'seq-new',
    observedSentAt: '2026-09-11T14:00:00Z',
  });
  assert.equal(SUPERSEDED_REASON, 'superseded_by_provider_accepted_restart');
});

test('superseded, unrelated, earlier, or unproven sends remain unresolved and block rotation', () => {
  const stale = {
    id: 'stale', batch_id: 'batch-old', lead_id: 'lead-a',
    authorized_at: '2026-09-11T12:00:00Z', first_touch_sequence_id: 'seq-old',
  };
  const earlier = {
    id: 'earlier', batch_id: 'batch-earlier', lead_id: 'lead-a',
    authorized_at: '2026-09-01T12:00:00Z', first_touch_sequence_id: 'seq-earlier',
    first_touch_sent_at: '2026-09-01T14:00:00Z',
  };
  assert.deepEqual(planRestartReceiptReconciliation({
    unconsumed: [stale], consumed: [earlier],
    sequences: [
      { id: 'seq-old', lead_id: 'lead-a', sequence_status: 'superseded', metadata: {} },
      delivered('seq-earlier', 'lead-a', '2026-09-01T14:00:00Z'),
    ],
  }), []);
});

function reconciliationDb({ unconsumed, consumed, sequences }) {
  const calls = [];
  function builder(table, op, payload = null) {
    const state = { table, op, payload, filters: [] };
    calls.push(state);
    const chain = {
      select() { return chain; },
      eq(key, value) { state.filters.push(['eq', key, value]); return chain; },
      not(key, operator, value) { state.filters.push(['not', key, operator, value]); return chain; },
      is(key, value) { state.filters.push(['is', key, value]); return chain; },
      in(key, value) { state.filters.push(['in', key, value]); return chain; },
      order() { return chain; },
      range() { return chain; },
      maybeSingle() { return chain; },
      then(resolve, reject) {
        try {
          if (op === 'update') {
            const id = state.filters.find((f) => f[0] === 'eq' && f[1] === 'id')?.[2];
            return Promise.resolve({ data: { id }, error: null }).then(resolve, reject);
          }
          if (table === 'growth_restart_candidates') {
            const wantsNull = state.filters.some((f) => f[0] === 'is' && f[1] === 'first_touch_sent_at');
            return Promise.resolve({ data: wantsNull ? unconsumed : consumed, error: null }).then(resolve, reject);
          }
          if (table === 'outreach_sequences') {
            return Promise.resolve({ data: sequences, error: null }).then(resolve, reject);
          }
          throw new Error(`unexpected table ${table}`);
        } catch (error) {
          return Promise.reject(error).then(resolve, reject);
        }
      },
    };
    return chain;
  }
  return {
    calls,
    from(table) {
      return {
        select() { return builder(table, 'select'); },
        update(payload) { return builder(table, 'update', payload); },
      };
    },
  };
}

test('reconciliation executes exact-FGA compare-and-set repairs and does not dispatch', async () => {
  const unconsumed = [
    {
      id: 'missing-receipt', batch_id: 'batch-a', lead_id: 'lead-a', decision: 'eligible',
      authorized_at: '2026-09-11T12:00:00Z', first_touch_sequence_id: 'seq-a', evidence: {},
    },
    {
      id: 'stale', batch_id: 'batch-old', lead_id: 'lead-b', decision: 'eligible',
      authorized_at: '2026-09-10T12:00:00Z', first_touch_sequence_id: 'seq-old', evidence: {},
    },
  ];
  const consumed = [{
    id: 'replacement', batch_id: 'batch-new', lead_id: 'lead-b',
    authorized_at: '2026-09-11T12:00:00Z', first_touch_sequence_id: 'seq-new',
    first_touch_sent_at: '2026-09-11T14:00:00Z',
  }];
  const db = reconciliationDb({
    unconsumed,
    consumed,
    sequences: [
      delivered('seq-a', 'lead-a'),
      { id: 'seq-old', lead_id: 'lead-b', sequence_status: 'superseded', metadata: {} },
      delivered('seq-new', 'lead-b'),
    ],
  });
  const result = await reconcileRestartReceipts(db, { observedAt: '2026-09-11T15:00:00Z' });
  assert.deepEqual(result, {
    examined: 2, consumed_bound: 1, excluded_superseded: 1, unresolved: 0, sends_messages: false,
  });
  const writes = db.calls.filter((call) => call.op === 'update');
  assert.equal(writes.length, 2);
  assert.equal(writes[0].payload.first_touch_sent_at, '2026-09-11T14:00:00Z');
  assert.equal(writes[1].payload.decision, 'excluded');
  assert.equal(writes[1].payload.reason, SUPERSEDED_REASON);
  for (const write of writes) {
    assert.ok(write.filters.some((filter) => filter[0] === 'eq'
      && filter[1] === 'tenant_id' && filter[2] === FGA_TENANT_ID));
    assert.ok(write.filters.some((filter) => filter[0] === 'is'
      && filter[1] === 'first_touch_sent_at' && filter[2] === null));
  }
});
