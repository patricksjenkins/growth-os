'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const plan = require('../../core/growth/seven-touch-plan');

test('seven-touch plan means one initial email plus six follow-ups through day 180', () => {
  assert.equal(plan.TOTAL_TOUCHES, 7);
  assert.deepEqual(plan.FOLLOW_UPS.map((step) => step.day), [3, 7, 14, 30, 90, 180]);
  assert.equal(plan.validatePlan().valid, true);
});

test('each follow-up has a distinct purpose and a low-friction reply request', () => {
  assert.equal(new Set(plan.FOLLOW_UPS.map((step) => step.purpose)).size, 6);
  for (const step of plan.FOLLOW_UPS) {
    assert.match(step.body, /reply|question|useful|covered|priority/i);
    assert.doesNotMatch(`${step.subject} ${step.body}`, /book a demo|guarantee|risk-free/i);
  }
});
