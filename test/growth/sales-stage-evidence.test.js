'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evidenceForSalesStage } = require('../../core/growth/sales-stage-evidence');

test('booking a demo proves both owner acceptance and the demo milestone', () => {
  assert.deepEqual(evidenceForSalesStage('demo_booked'), [
    { eventType: 'owner_accepted_sales_handoff', stage: 'owner_accepted' },
    { eventType: 'demo_booked', stage: null },
  ]);
});

test('proposal and won changes project to canonical outcome stages', () => {
  assert.deepEqual(evidenceForSalesStage('quoted'), [
    { eventType: 'proposal_sent_owner_verified', stage: 'proposal' },
  ]);
  assert.deepEqual(evidenceForSalesStage('won'), [
    { eventType: 'closed_won_owner_verified', stage: 'won' },
  ]);
});

test('non-outcome edits never fabricate growth evidence', () => {
  assert.deepEqual(evidenceForSalesStage('contacted'), []);
  assert.deepEqual(evidenceForSalesStage('new_lead'), []);
});
