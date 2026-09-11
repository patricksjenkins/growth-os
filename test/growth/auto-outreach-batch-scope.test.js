'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const autoOutreach = require('../../worker/agents/auto-outreach');

test('a restart activation job accepts only drafts from its requested batch', () => {
  assert.equal(autoOutreach.draftMatchesRequestedBatch(
    { metadata: { restart_batch_id: 'batch-a' } },
    { restart_batch_id: 'batch-a' },
  ), true);
  assert.equal(autoOutreach.draftMatchesRequestedBatch(
    { metadata: { restart_batch_id: 'batch-b' } },
    { restart_batch_id: 'batch-a' },
  ), false);
  assert.equal(autoOutreach.draftMatchesRequestedBatch(
    { metadata: {} },
    { restart_batch_id: 'batch-a' },
  ), false);
});

test('ordinary scheduled runs retain the existing unscoped draft behavior', () => {
  assert.equal(autoOutreach.draftMatchesRequestedBatch({ metadata: {} }, {}), true);
});
