'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { channelsForLead, rankDraftCandidates } = require('../../worker/agents/outreach');

test('restart authorization produces only the governed email first touch', () => {
  assert.deepEqual(channelsForLead({
    contactEmail: 'prospect@example.test',
    facebookUrl: 'https://facebook.com/example',
    payload: { lead_id: 'lead-1', restart_batch_id: 'batch-1' },
  }), ['email']);
});

test('an explicit owner single-lead request may still create both drafts', () => {
  assert.deepEqual(channelsForLead({
    contactEmail: 'prospect@example.test',
    facebookUrl: 'https://facebook.com/example',
    payload: { lead_id: 'lead-1' },
  }), ['email', 'facebook_dm']);
});

test('scheduled runs never create an automatic Facebook draft', () => {
  assert.deepEqual(channelsForLead({
    contactEmail: null,
    facebookUrl: 'https://facebook.com/example',
    payload: {},
  }), []);
});

test('drafting exhausts existing 1-9 inventory before accepted 10-19 and new discovery', () => {
  const leads = [
    { id: 'new-sweet', created_at: '2026-09-11T00:00:00Z', employee_count_actual: 3, lead_score: 99 },
    { id: 'existing-accepted', created_at: '2026-08-01T00:00:00Z', employee_count_actual: 11, lead_score: 99 },
    { id: 'existing-sweet', created_at: '2026-08-01T00:00:00Z', employee_count_actual: 4, lead_score: 60 },
  ];
  assert.deepEqual(
    rankDraftCandidates(leads).map((lead) => lead.id),
    ['existing-sweet', 'existing-accepted', 'new-sweet'],
  );
});
