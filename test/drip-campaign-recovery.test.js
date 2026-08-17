'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';

const dripAgent = require('../worker/agents/drip-campaign');
const {
  processDueBatch,
  failureMetadata,
  MAX_SENDS_PER_RUN,
  MAX_CANDIDATES_PER_RUN,
  MAX_FAILURES_PER_TOUCH,
} = dripAgent._test;

test('a poisoned head cohort cannot starve healthy enrollments behind it', async () => {
  assert.ok(MAX_CANDIDATES_PER_RUN > MAX_SENDS_PER_RUN);
  const due = Array.from({ length: 50 }, (_, index) => ({
    id: `enrollment-${index}`,
    lead_id: `lead-${index}`,
    next_step_day: index < 25 ? 30 : 7,
  }));
  const attempted = [];
  const deferred = [];
  const recorded = [];

  const batch = await processDueBatch(due, {
    dailyBudget: 30,
    processOne: async (enrollment) => {
      attempted.push(enrollment.id);
      if (Number(enrollment.id.split('-')[1]) < 25) {
        throw new Error('permanent coupon configuration failure');
      }
      return { enrollment_id: enrollment.id, bucket: 'sent', day: enrollment.next_step_day };
    },
    handleFailure: async (enrollment) => {
      deferred.push(enrollment.id);
      return { failure_count: 1, next_send_at: '2026-08-17T13:00:00Z' };
    },
    recordOutcome: async (_enrollment, outcome) => recorded.push(outcome),
  });

  assert.strictEqual(batch.results.failed, 25);
  assert.strictEqual(batch.results.sent, 25);
  assert.strictEqual(batch.dailyBudget, 5);
  assert.strictEqual(attempted.length, 50, 'healthy rows behind the poisoned 25 must be attempted');
  assert.strictEqual(deferred.length, 25, 'each poison row is moved out of the queue head');
  assert.strictEqual(recorded.length, 50, 'every evaluated delivery leaves evidence');
});

test('failure counting is per touch and supports bounded quarantine', () => {
  let enrollment = { next_step_day: 30, metadata: {} };
  for (let count = 1; count <= MAX_FAILURES_PER_TOUCH; count++) {
    const metadata = failureMetadata(enrollment, new Error('bad config'));
    assert.strictEqual(metadata.drip_failure_count, count);
    enrollment = { ...enrollment, metadata };
  }
  const nextTouch = failureMetadata({ ...enrollment, next_step_day: 45 }, new Error('new failure'));
  assert.strictEqual(nextTouch.drip_failure_count, 1, 'a later touch gets a fresh retry budget');
});

test('migration adds append-only queryable non-delivery evidence', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db/migrations/105_drip_delivery_attempts.sql'), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.drip_delivery_attempts/);
  assert.match(sql, /outcome IN \('sent', 'skipped', 'stopped', 'failed', 'rescheduled'\)/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.doesNotMatch(sql, /FOR (?:INSERT|UPDATE|DELETE) TO authenticated/);
});
