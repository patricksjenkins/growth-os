'use strict';

const ACCEPTED_EVENT_TYPES = new Set([
  'first_touch_provider_accepted',
  'sequence_touch_provider_accepted',
]);

/**
 * Convert immutable provider receipts into honest funnel outcomes. Delivery is
 * counted only when it links back to a provider-accepted message ID; an
 * uncorrelated webhook must never inflate the delivery rate.
 */
function providerOutcomeMetrics(events = []) {
  const acceptedProviderIds = new Set(events
    .filter((row) => ACCEPTED_EVENT_TYPES.has(row.event_type))
    .map((row) => row.source_id)
    .filter(Boolean));
  const deliveredEvents = events.filter((row) => row.event_type === 'email_delivered');
  const linkedDeliveries = deliveredEvents.filter((row) => (
    row.correlation_id && acceptedProviderIds.has(row.correlation_id)
  ));
  const humanReplies = events.filter((row) => row.event_type === 'human_reply_received').length;
  const warmReplies = events.filter((row) => row.event_type === 'human_reply_received' && row.stage === 'warm').length;
  const providerAccepted = acceptedProviderIds.size;
  const delivered = linkedDeliveries.length;

  return {
    providerAccepted,
    delivered,
    humanReplies,
    warmReplies,
    unmatchedDeliveries: deliveredEvents.length - linkedDeliveries.length,
    deliveryRate: providerAccepted ? Number((delivered / providerAccepted * 100).toFixed(1)) : null,
    replyRate: delivered ? Number((humanReplies / delivered * 100).toFixed(1)) : null,
    warmRate: delivered ? Number((warmReplies / delivered * 100).toFixed(1)) : null,
  };
}

/** Count only outbound prospects that have a canonical stage projection. */
function pipelineEvidenceCoverage(prospectLeads = [], stageRows = []) {
  const prospectIds = new Set(prospectLeads.map((lead) => lead.id).filter(Boolean));
  const coveredIds = new Set(stageRows
    .map((row) => row.lead_id)
    .filter((leadId) => prospectIds.has(leadId)));
  const total = prospectIds.size;
  const covered = coveredIds.size;
  return {
    covered,
    total,
    ratio: total ? covered / total : 0,
    percentage: total ? Number((covered / total * 100).toFixed(1)) : 0,
  };
}

/**
 * Classify the evidence required to operate the currently qualified inventory.
 * A failed optional enrichment provider limits future scale, but it must not
 * masquerade as a safety failure when source-backed, qualified inventory is
 * already available. Provider and receipt debt remain visible as warnings.
 */
function growthReadiness({
  campaignReady = false,
  webhookSecretConfigured = false,
  webhookVerified = false,
  replySyncFresh = false,
  employeeProviderRejected = false,
  qualifiedInventory = 0,
  evidenceCoverageRatio = 0,
  unmatchedDeliveryEvents = 0,
} = {}) {
  const blockers = [
    !campaignReady && 'seven_touch_campaign_not_active',
    !webhookSecretConfigured && 'resend_webhook_secret_missing',
    webhookSecretConfigured && !webhookVerified && 'resend_webhook_unproven',
    !replySyncFresh && 'reply_sync_not_fresh',
    Number(qualifiedInventory) === 0 && 'no_qualified_inventory',
  ].filter(Boolean);
  const warnings = [
    employeeProviderRejected && 'employee_evidence_provider_rejected',
    Number(unmatchedDeliveryEvents) > 0 && 'historical_delivery_receipts_unmatched',
  ].filter(Boolean);

  return {
    blockers,
    warnings,
    authority: blockers.length
      ? 'not_ready'
      : Number(evidenceCoverageRatio) < 0.8
        ? 'collecting_evidence'
        : 'operational',
  };
}

module.exports = {
  ACCEPTED_EVENT_TYPES,
  providerOutcomeMetrics,
  pipelineEvidenceCoverage,
  growthReadiness,
};
