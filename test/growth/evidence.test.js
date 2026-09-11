'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { providerOutcomeMetrics, pipelineEvidenceCoverage, growthReadiness } = require('../../core/growth/evidence');

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

test('optional employee provider failure warns without blocking qualified inventory', () => {
  const result = growthReadiness({
    campaignReady: true,
    webhookSecretConfigured: true,
    webhookVerified: true,
    replySyncFresh: true,
    employeeProviderRejected: true,
    qualifiedInventory: 876,
    evidenceCoverageRatio: 1,
    unmatchedDeliveryEvents: 72,
  });

  assert.deepEqual(result, {
    blockers: [],
    warnings: [
      'employee_evidence_provider_rejected',
      'historical_delivery_receipts_unmatched',
    ],
    authority: 'operational',
  });
});

test('safety and reply evidence remain hard Growth Engine blockers', () => {
  const result = growthReadiness({
    campaignReady: false,
    webhookSecretConfigured: true,
    webhookVerified: false,
    replySyncFresh: false,
    employeeProviderRejected: false,
    qualifiedInventory: 0,
    evidenceCoverageRatio: 1,
  });

  assert.equal(result.authority, 'not_ready');
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.blockers, [
    'seven_touch_campaign_not_active',
    'resend_webhook_unproven',
    'reply_sync_not_fresh',
    'no_qualified_inventory',
  ]);
});

test('low canonical coverage remains collecting evidence when safety gates pass', () => {
  const result = growthReadiness({
    campaignReady: true,
    webhookSecretConfigured: true,
    webhookVerified: true,
    replySyncFresh: true,
    qualifiedInventory: 10,
    evidenceCoverageRatio: 0.79,
  });

  assert.equal(result.authority, 'collecting_evidence');
  assert.deepEqual(result.blockers, []);
});
