'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { regenerationFeedbackBlock } = require('../worker/agents/outreach');

test('automated quality feedback is never attributed to Patrick', () => {
  const block = regenerationFeedbackBlock({
    regenerate_feedback: 'Make the question fit the prospect industry.',
    regenerate_feedback_source: 'quality_gate',
  });
  assert.match(block, /AUTOMATED QUALITY GATE FEEDBACK/);
  assert.doesNotMatch(block, /PATRICK|OWNER/i);
});

test('owner feedback remains distinguishable and empty feedback adds nothing', () => {
  assert.match(regenerationFeedbackBlock({
    regenerate_feedback: 'Use a less formal tone.',
  }), /OWNER REGENERATION FEEDBACK/);
  assert.equal(regenerationFeedbackBlock({ regenerate_feedback: '   ' }), '');
});
