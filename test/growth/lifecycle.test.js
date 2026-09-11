'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fgaLifecycleAfterResearch } = require('../../core/growth/lifecycle');

test('research advances an uncontacted prospect through enrichment and scoring', () => {
  assert.equal(fgaLifecycleAfterResearch(
    { status: 'new_lead', lifecycle_stage: 'prospect' },
    'enriched',
  ), 'enriched');
  assert.equal(fgaLifecycleAfterResearch(
    { status: 'new_lead', lifecycle_stage: 'enriched' },
    'scored',
  ), 'scored');
});

test('research cannot regress sequenced or engaged FGA prospects', () => {
  assert.equal(fgaLifecycleAfterResearch(
    { status: 'new_lead', lifecycle_stage: 'sequenced' },
    'enriched',
  ), 'sequenced');
  assert.equal(fgaLifecycleAfterResearch(
    { status: 'interested', lifecycle_stage: 'engaged' },
    'scored',
  ), 'interested');
});

test('contacted status repairs an already-regressed early lifecycle to sequenced', () => {
  assert.equal(fgaLifecycleAfterResearch(
    { status: 'contacted', lifecycle_stage: 'enriched' },
    'enriched',
  ), 'sequenced');
  assert.equal(fgaLifecycleAfterResearch(
    { status: 'contacted', lifecycle_stage: 'enriched' },
    'scored',
  ), 'sequenced');
});

test('unknown and terminal lifecycle values fail closed', () => {
  assert.equal(fgaLifecycleAfterResearch(
    { status: 'new_lead', lifecycle_stage: 'custom_handoff' },
    'enriched',
  ), 'custom_handoff');
  assert.equal(fgaLifecycleAfterResearch(
    { status: 'unsubscribed', lifecycle_stage: 'disqualified' },
    'scored',
  ), 'disqualified');
});
