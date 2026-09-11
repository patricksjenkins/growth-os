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

test('ordinary discovery cannot consume capacity reserved for a reviewed restart in a later local window', () => {
  const ordinary = { lead_id: 'ordinary', metadata: {} };
  const restart = { lead_id: 'restart', metadata: { restart_batch_id: 'reviewed-batch' } };
  assert.equal(autoOutreach.mustReserveForRestartWindow(ordinary, 8, 8), true);
  assert.equal(autoOutreach.mustReserveForRestartWindow(ordinary, 9, 8), false);
  assert.equal(autoOutreach.mustReserveForRestartWindow(restart, 8, 8), false);
});

test('restart capacity is derived from durable unconsumed authority, including drafting still in progress', () => {
  const drafts = [
    { id: 'sequence-a', lead_id: 'lead-a', metadata: { restart_batch_id: 'batch' } },
    { id: 'sequence-stale', lead_id: 'lead-stale', metadata: { restart_batch_id: 'batch' } },
    { id: 'ordinary', lead_id: 'lead-ordinary', metadata: {} },
  ];
  const pending = [
    { lead_id: 'lead-a', first_touch_sequence_id: 'sequence-a' },
    { lead_id: 'lead-drafting', first_touch_sequence_id: null },
    { lead_id: 'lead-stale', first_touch_sequence_id: 'different-sequence' },
    { lead_id: 'lead-a', first_touch_sequence_id: 'sequence-a' },
  ];
  assert.deepEqual(
    [...autoOutreach.restartReservationLeadIds(drafts, pending)].sort(),
    ['lead-a', 'lead-drafting'],
  );
});

test('the production sender fails closed if durable restart reservations cannot be read', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '../../worker/agents/auto-outreach.js'), 'utf8');
  const reservationRead = source.indexOf(".from('growth_restart_candidates')");
  const providerCall = source.indexOf('sendEmailOutreachSequence');
  assert.ok(reservationRead >= 0 && providerCall > reservationRead,
    'restart capacity authority must be proven before the first provider call');
  assert.match(source, /autosend_restart_reservation_failed/);
});

test('the provider-owning worker always injects a real dispatch clock into the local-window gate', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '../../worker/agents/auto-outreach.js'), 'utf8');
  assert.match(source, /const sendWindowNow = new Date\(\)/);
  assert.match(source, /evaluateLeadForAutoSend\([\s\S]*?sendWindowNow,[\s\S]*?\)/);
});
