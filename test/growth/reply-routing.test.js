'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { leadOutcomeForReplyIntent } = require('../../core/drip-gmail');

test('positive reply intents become warm while a no becomes terminal', () => {
  assert.deepEqual(leadOutcomeForReplyIntent('interested'), {
    status: 'interested', lifecycle_stage: 'interested', warm: true,
  });
  assert.deepEqual(leadOutcomeForReplyIntent('question'), {
    status: 'interested', lifecycle_stage: 'engaged', warm: true,
  });
  assert.deepEqual(leadOutcomeForReplyIntent('not_interested'), {
    status: 'declined', lifecycle_stage: 'disqualified', warm: false,
  });
  assert.deepEqual(leadOutcomeForReplyIntent('objection'), {
    status: 'replied', lifecycle_stage: 'replied', warm: false,
  });
});
