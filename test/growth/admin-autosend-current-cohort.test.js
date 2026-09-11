'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { _test } = require('../../api/routes/admin-autosend');

test('autonomous-outreach queue reports the current authorized cohort, not historical lead states', () => {
  const candidates = [
    { first_touch_sequence_id: 'ready' },
    { first_touch_sequence_id: 'awaiting' },
    { first_touch_sequence_id: 'review' },
    { first_touch_sequence_id: 'missing' },
  ];
  const sequences = [
    { id: 'ready', sequence_status: 'draft', metadata: { autosend_quality: { ok: true } } },
    { id: 'awaiting', sequence_status: 'draft', metadata: {} },
    { id: 'review', sequence_status: 'draft', metadata: { autosend_quality: { ok: false } } },
  ];
  assert.deepEqual(_test.summarizeCurrentRestartQueue(candidates, sequences), {
    scope: 'current_restart_cohort',
    authorized_remaining: 4,
    drafts_ready: 1,
    awaiting_gate: 1,
    needs_review: 1,
    blocked: 1,
  });
});

test('an exhausted cohort is an explicit zero, never historical queue fallback', () => {
  assert.deepEqual(_test.summarizeCurrentRestartQueue([], []), {
    scope: 'current_restart_cohort',
    authorized_remaining: 0,
    drafts_ready: 0,
    awaiting_gate: 0,
    needs_review: 0,
    blocked: 0,
  });
});
