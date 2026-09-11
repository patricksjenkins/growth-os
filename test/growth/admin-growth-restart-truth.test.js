'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';

const { summarizeRestartCandidates } = require('../../api/routes/admin-growth')._test;

test('restart readout separates eligibility, authorization, drafting, and provider acceptance', () => {
  const summary = summarizeRestartCandidates([
    { decision: 'eligible', authorized_at: 'x', first_touch_sequence_id: 's1', first_touch_sent_at: 'y' },
    { decision: 'eligible', authorized_at: 'x', first_touch_sequence_id: 's2', first_touch_sent_at: null },
    { decision: 'eligible', authorized_at: null, first_touch_sequence_id: null, first_touch_sent_at: null },
    { decision: 'needs_evidence' },
    { decision: 'excluded' },
  ]);
  assert.deepEqual(summary, {
    total: 5,
    authorized: 2,
    drafted: 2,
    provider_accepted: 1,
    remaining_reviewed: 1,
    by_decision: { eligible: 3, needs_evidence: 1, excluded: 1 },
  });
});

test('zero evidence remains an explicit zero state rather than an inferred label', () => {
  assert.deepEqual(summarizeRestartCandidates(), {
    total: 0,
    authorized: 0,
    drafted: 0,
    provider_accepted: 0,
    remaining_reviewed: 0,
    by_decision: {},
  });
});
