'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const plan = require('../../core/growth/seven-touch-plan');

test('seven-touch plan means one initial email plus six follow-ups through day 180', () => {
  assert.equal(plan.TOTAL_TOUCHES, 7);
  assert.equal(plan.PLAN_KEY, 'database-first-seven-touch-v2');
  assert.deepEqual(plan.FOLLOW_UPS.map((step) => step.day), [3, 7, 14, 30, 90, 180]);
  assert.equal(plan.validatePlan().valid, true);
});

test('the plan prioritizes existing inventory and measures business outcomes', () => {
  assert.match(plan.AUDIENCE.priority_order[0], /^Existing FGA prospects/);
  assert.equal(plan.VOLUME.initial_daily_cap, 25);
  assert.equal(plan.requiredSteadyStateFollowupCapacity(25, 7), 150);
  assert.equal(plan.VOLUME.followup_daily_cap, 150);
  assert.deepEqual(plan.TOUCHES.map((touch) => touch.day), plan.TOUCH_DAYS);
  assert.ok(plan.STOP_CONDITIONS.some((rule) => rule.includes('human reply')));
  assert.ok(plan.OUTCOME_LADDER.includes('warm_reply'));
  assert.ok(plan.OUTCOME_LADDER.includes('won'));
});

test('each follow-up has a distinct purpose and a low-friction reply request', () => {
  assert.equal(new Set(plan.FOLLOW_UPS.map((step) => step.purpose)).size, 6);
  for (const step of plan.FOLLOW_UPS) {
    assert.match(step.body, /reply|question|useful|covered|priority/i);
    assert.doesNotMatch(`${step.subject} ${step.body}`, /book a demo|guarantee|risk-free/i);
  }
});
