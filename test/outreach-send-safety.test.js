'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sendEmailOutreachSequence } = require('../core/outreach-send');

const SEQUENCE = {
  id: 'sequence-a',
  tenant_id: '30566ed6-026a-45e1-9502-029e6219df31',
  lead_id: 'lead-a',
  contact_id: null,
  sequence_type: 'email',
  sequence_status: 'draft',
  message_subject: 'A real subject',
  message_body: 'A real approved body',
  metadata: {},
};

function fakeDb(handler) {
  return {
    from(table) {
      const state = { table, op: 'select', row: null, single: false, filters: [] };
      const builder = {
        select() { return builder; },
        update(row) { state.op = 'update'; state.row = row; return builder; },
        insert(row) { state.op = 'insert'; state.row = row; return builder; },
        eq(column, value) { state.filters.push(['eq', column, value]); return builder; },
        order() { return builder; },
        limit() { return builder; },
        single() { state.single = true; return builder; },
        maybeSingle() { state.single = true; return builder; },
        then(resolve, reject) {
          try { return Promise.resolve(handler(state)).then(resolve, reject); }
          catch (error) { return reject(error); }
        },
      };
      return builder;
    },
  };
}

test('a failed atomic claim stops before any provider can be called', async () => {
  const db = fakeDb((state) => {
    if (state.table === 'outreach_sequences' && state.op === 'select') {
      return { data: SEQUENCE, error: null };
    }
    if (state.table === 'outreach_sequences' && state.row?.sequence_status === 'sending') {
      return { data: null, error: { message: 'write unavailable' } };
    }
    throw new Error(`unexpected query ${state.table}:${state.op}`);
  });
  const result = await sendEmailOutreachSequence(db, 'lead-a', 'sequence-a', { sentVia: 'auto_send' });
  assert.deepEqual(result, { ok: false, code: 'claim_failed', error: 'Could not safely claim this draft' });
});

test('an unreadable lead identity releases the claim and never reaches delivery', async () => {
  const transitions = [];
  const db = fakeDb((state) => {
    if (state.table === 'outreach_sequences' && state.op === 'select') {
      return { data: SEQUENCE, error: null };
    }
    if (state.table === 'outreach_sequences' && state.op === 'update') {
      transitions.push(state.row.sequence_status);
      return { data: state.row.sequence_status === 'sending' ? [{ id: 'sequence-a' }] : null, error: null };
    }
    if (state.table === 'leads') return { data: null, error: { message: 'identity store unavailable' } };
    throw new Error(`unexpected query ${state.table}:${state.op}`);
  });
  const result = await sendEmailOutreachSequence(db, 'lead-a', 'sequence-a', { sentVia: 'auto_send' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'lead_not_in_tenant');
  assert.deepEqual(transitions, ['sending', 'draft']);
});
