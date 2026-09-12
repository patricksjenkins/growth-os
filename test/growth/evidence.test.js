'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { providerOutcomeMetrics, pipelineEvidenceCoverage, growthReadiness } = require('../../core/growth/evidence');

test('provider outcomes count only delivery receipts linked to accepted provider IDs', () => {
  const result = providerOutcomeMetrics([
    { event_type: 'first_touch_provider_accepted', source_id: 'email-a', lead_id: 'lead-a', occurred_at: '2026-09-01T10:00:00Z' },
    { event_type: 'sequence_touch_provider_accepted', source_id: 'email-b', lead_id: 'lead-b', occurred_at: '2026-09-01T10:00:00Z' },
    // Duplicate acceptance receipt for the same provider message must not
    // inflate the denominator.
    { event_type: 'sequence_touch_provider_accepted', source_id: 'email-b', lead_id: 'lead-b', occurred_at: '2026-09-01T10:00:00Z' },
    { event_type: 'email_delivered', correlation_id: 'email-a' },
    { event_type: 'email_delivered', correlation_id: 'unmatched' },
    { event_type: 'human_reply_received', stage: 'warm', lead_id: 'lead-a', occurred_at: '2026-09-02T10:00:00Z' },
  ]);

  assert.deepEqual(result, {
    providerAccepted: 2,
    delivered: 1,
    providerAcceptedProspects: 2,
    deliveredProspects: 1,
    humanReplies: 1,
    warmReplies: 1,
    attributableHumanReplies: 1,
    attributableWarmReplies: 1,
    unattributedHumanReplies: 0,
    unmatchedDeliveries: 1,
    deliveryRate: 50,
    replyRate: 50,
    warmRate: 100,
  });
});

test('warm replies are a subset of human replies rather than arbitrary warm-stage events', () => {
  const result = providerOutcomeMetrics([
    { event_type: 'first_touch_provider_accepted', source_id: 'email-a', lead_id: 'lead-a', occurred_at: '2026-09-01T10:00:00Z' },
    { event_type: 'email_delivered', correlation_id: 'email-a' },
    { event_type: 'human_reply_received', stage: 'human_reply', lead_id: 'lead-a', occurred_at: '2026-09-02T10:00:00Z' },
    { event_type: 'lead_promoted', stage: 'warm' },
  ]);
  assert.equal(result.humanReplies, 1);
  assert.equal(result.warmReplies, 0);
  assert.equal(result.replyRate, 100);
  assert.equal(result.warmRate, 0);
});

test('reply conversion counts unique prospects, not follow-up or reply message volume', () => {
  const result = providerOutcomeMetrics([
    { event_type: 'first_touch_provider_accepted', source_id: 'a-1', lead_id: 'lead-a', occurred_at: '2026-09-01T10:00:00Z' },
    { event_type: 'sequence_touch_provider_accepted', source_id: 'a-2', lead_id: 'lead-a', occurred_at: '2026-09-04T10:00:00Z' },
    { event_type: 'first_touch_provider_accepted', source_id: 'b-1', lead_id: 'lead-b', occurred_at: '2026-09-01T10:00:00Z' },
    { event_type: 'email_delivered', correlation_id: 'a-1' },
    { event_type: 'email_delivered', correlation_id: 'a-1' },
    { event_type: 'email_delivered', correlation_id: 'a-2' },
    { event_type: 'email_delivered', correlation_id: 'b-1' },
    { event_type: 'human_reply_received', stage: 'warm', lead_id: 'lead-a', occurred_at: '2026-09-05T10:00:00Z' },
    { event_type: 'human_reply_received', stage: 'warm', lead_id: 'lead-a', occurred_at: '2026-09-05T11:00:00Z' },
    // This period reply is visible, but it has no accepted outreach receipt
    // in the evidence window and cannot change this cohort's rate.
    { event_type: 'human_reply_received', stage: 'human_reply', lead_id: 'lead-c', occurred_at: '2026-09-05T12:00:00Z' },
  ]);

  assert.equal(result.providerAccepted, 3);
  assert.equal(result.delivered, 3, 'duplicate delivery callbacks count once');
  assert.equal(result.providerAcceptedProspects, 2);
  assert.equal(result.deliveredProspects, 2);
  assert.equal(result.humanReplies, 2);
  assert.equal(result.warmReplies, 1);
  assert.equal(result.attributableHumanReplies, 1);
  assert.equal(result.unattributedHumanReplies, 1);
  assert.equal(result.deliveryRate, 100);
  assert.equal(result.replyRate, 50);
  assert.equal(result.warmRate, 100);
});

test('a reply dated before its accepted outreach cannot become conversion evidence', () => {
  const result = providerOutcomeMetrics([
    { event_type: 'human_reply_received', stage: 'warm', lead_id: 'lead-a', occurred_at: '2026-09-01T10:00:00Z' },
    { event_type: 'first_touch_provider_accepted', source_id: 'a-1', lead_id: 'lead-a', occurred_at: '2026-09-02T10:00:00Z' },
  ]);
  assert.equal(result.humanReplies, 1);
  assert.equal(result.attributableHumanReplies, 0);
  assert.equal(result.unattributedHumanReplies, 1);
  assert.equal(result.replyRate, 0);
  assert.equal(result.warmRate, null);
});

test('conflicting acceptance replays and unmatched delivery replays cannot inflate cohorts', () => {
  const result = providerOutcomeMetrics([
    { event_type: 'first_touch_provider_accepted', source_id: 'provider-1', lead_id: 'lead-a', occurred_at: '2026-09-01T10:00:00Z' },
    { event_type: 'first_touch_provider_accepted', source_id: 'provider-1', lead_id: 'lead-b', occurred_at: '2026-09-01T11:00:00Z' },
    { event_type: 'email_delivered', correlation_id: 'unknown-provider' },
    { event_type: 'email_delivered', correlation_id: 'unknown-provider' },
  ]);

  assert.equal(result.providerAccepted, 1);
  assert.equal(result.providerAcceptedProspects, 1);
  assert.equal(result.unmatchedDeliveries, 1);
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
