'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { priorTouchGateStatus } = require('../../scripts/outreach-funnel-trace');

test('funnel trace treats an exact durable restart authorization like the sender does', () => {
  assert.deepEqual(
    priorTouchGateStatus({ priorSent: [{ id: 'old-send' }], restart: { authorized: true, batchId: 'batch-1' } }),
    { pass: true, detail: 'authorized_restart:batch-1' },
  );
});

test('funnel trace still fails a prior touch without restart authority', () => {
  assert.deepEqual(
    priorTouchGateStatus({ priorSent: [{ id: 'old-send' }], restart: { authorized: false, reason: 'candidate_not_authorized' } }),
    { pass: false, detail: 'candidate_not_authorized' },
  );
  assert.deepEqual(
    priorTouchGateStatus({ priorSent: [] }),
    { pass: true, detail: 'first_touch' },
  );
});
