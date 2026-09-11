'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { channelsForLead } = require('../../worker/agents/outreach');

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
