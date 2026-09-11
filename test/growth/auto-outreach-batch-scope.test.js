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

test('sending uses the same database-first audience order as drafting', () => {
  const drafts = [{ lead_id: 'new' }, { lead_id: 'accepted' }, { lead_id: 'sweet' }];
  const leads = new Map([
    ['new', { id: 'new', created_at: '2026-09-11T00:00:00Z', employee_count_actual: 2, lead_score: 99 }],
    ['accepted', { id: 'accepted', created_at: '2026-08-01T00:00:00Z', employee_count_actual: 11, lead_score: 99 }],
    ['sweet', { id: 'sweet', created_at: '2026-08-01T00:00:00Z', employee_count_actual: 3, lead_score: 60 }],
  ]);
  assert.deepEqual(
    autoOutreach.rankSendCandidates(drafts, leads).map((draft) => draft.lead_id),
    ['sweet', 'accepted', 'new'],
  );
});

test('a scheduled run works durable restart requests before ordinary new drafts', () => {
  const drafts = [
    { lead_id: 'ordinary', metadata: {} },
    { lead_id: 'restart', metadata: { restart_batch_id: 'reviewed-batch' } },
  ];
  const leads = new Map([
    ['ordinary', { id: 'ordinary', created_at: '2026-08-01T00:00:00Z', employee_count_actual: 2, lead_score: 99 }],
    ['restart', { id: 'restart', created_at: '2026-08-01T00:00:00Z', employee_count_actual: 9, lead_score: 60 }],
  ]);
  assert.deepEqual(
    autoOutreach.rankSendCandidates(drafts, leads).map((draft) => draft.lead_id),
    ['restart', 'ordinary'],
  );
});
