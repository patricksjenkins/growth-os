'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { providerOutcomeMetrics, pipelineEvidenceCoverage } = require('../../core/growth/evidence');

test('provider outcomes count only delivery receipts linked to accepted provider IDs', () => {
  const result = providerOutcomeMetrics([
    { event_type: 'first_touch_provider_accepted', source_id: 'email-a' },
    { event_type: 'sequence_touch_provider_accepted', source_id: 'email-b' },
    // Duplicate acceptance receipt for the same provider message must not
    // inflate the denominator.
    { event_type: 'sequence_touch_provider_accepted', source_id: 'email-b' },
    { event_type: 'email_delivered', correlation_id: 'email-a' },
    { event_type: 'email_delivered', correlation_id: 'unmatched' },
    { event_type: 'human_reply_received', stage: 'warm' },
  ]);

  assert.deepEqual(result, {
    providerAccepted: 2,
    delivered: 1,
    humanReplies: 1,
    warmReplies: 1,
    unmatchedDeliveries: 1,
    deliveryRate: 50,
    replyRate: 100,
    warmRate: 100,
  });
});

test('warm replies are a subset of human replies rather than arbitrary warm-stage events', () => {
  const result = providerOutcomeMetrics([
    { event_type: 'first_touch_provider_accepted', source_id: 'email-a' },
    { event_type: 'email_delivered', correlation_id: 'email-a' },
    { event_type: 'human_reply_received', stage: 'human_reply' },
    { event_type: 'lead_promoted', stage: 'warm' },
  ]);
  assert.equal(result.humanReplies, 1);
  assert.equal(result.warmReplies, 0);
});

test('evidence coverage cannot exceed the outbound prospect population', () => {
  const result = pipelineEvidenceCoverage(
    [{ id: 'lead-a' }, { id: 'lead-b' }],
    [
      { lead_id: 'lead-a' },
      { lead_id: 'lead-a' },
      { lead_id: 'website-lead-outside-denominator' },
    ],
  );
  assert.deepEqual(result, { covered: 1, total: 2, ratio: 0.5, percentage: 50 });
});
