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
  const acceptedByProviderId = new Map();
  const firstAcceptedAtByLead = new Map();
  for (const row of events) {
    if (!ACCEPTED_EVENT_TYPES.has(row.event_type) || !row.source_id) continue;
    // One provider message can belong to only one prospect. A replay carrying
    // a conflicting lead identity is evidence debt, not a second accepted
    // prospect. Preserve the first immutable receipt for every downstream
    // delivery and cohort calculation.
    if (acceptedByProviderId.has(row.source_id)) continue;
    acceptedByProviderId.set(row.source_id, row);
    if (!row.lead_id) continue;
    const at = Date.parse(row.occurred_at || '');
    const previous = firstAcceptedAtByLead.get(row.lead_id);
    if (previous === undefined || (Number.isFinite(at) && at < previous)) {
      firstAcceptedAtByLead.set(row.lead_id, Number.isFinite(at) ? at : -Infinity);
    }
  }
  const acceptedProviderIds = new Set(acceptedByProviderId.keys());
  const acceptedLeadIds = new Set(firstAcceptedAtByLead.keys());
  const deliveredEvents = events.filter((row) => row.event_type === 'email_delivered');
  const linkedDeliveries = deliveredEvents.filter((row) => (
    row.correlation_id && acceptedProviderIds.has(row.correlation_id)
  ));
  // Webhook retries or provider state replays are one delivered message, not
  // additional business outcomes. Correlation identity is the provider send
  // id already proven by the acceptance ledger above.
  const linkedDeliveryIds = new Set(linkedDeliveries.map((row) => row.correlation_id));
  const deliveredLeadIds = new Set();
  for (const providerId of linkedDeliveryIds) {
    const leadId = acceptedByProviderId.get(providerId)?.lead_id;
    if (leadId) deliveredLeadIds.add(leadId);
  }

  // Replies are people, not messages. One prospect replying twice must not
  // count twice, and six follow-ups to one prospect must not dilute the
  // prospect response rate. The denominator is unique prospects with an
  // accepted outreach receipt inside this evidence window. Replies outside
  // that cohort remain visible but cannot change its conversion rate.
  const humanReplyLeadIds = new Set();
  const warmReplyLeadIds = new Set();
  const attributableHumanReplyLeadIds = new Set();
  const attributableWarmReplyLeadIds = new Set();
  for (const row of events) {
    if (row.event_type !== 'human_reply_received' || !row.lead_id) continue;
    humanReplyLeadIds.add(row.lead_id);
    if (row.stage === 'warm') warmReplyLeadIds.add(row.lead_id);
    const acceptedAt = firstAcceptedAtByLead.get(row.lead_id);
    const replyAt = Date.parse(row.occurred_at || '');
    if (acceptedAt === undefined || (Number.isFinite(replyAt) && replyAt < acceptedAt)) continue;
    attributableHumanReplyLeadIds.add(row.lead_id);
    if (row.stage === 'warm') attributableWarmReplyLeadIds.add(row.lead_id);
  }
  const providerAccepted = acceptedProviderIds.size;
  const delivered = linkedDeliveryIds.size;
  const humanReplies = humanReplyLeadIds.size;
  const warmReplies = warmReplyLeadIds.size;
  const attributableHumanReplies = attributableHumanReplyLeadIds.size;
  const attributableWarmReplies = attributableWarmReplyLeadIds.size;
  const providerAcceptedProspects = acceptedLeadIds.size;

  return {
    providerAccepted,
    delivered,
    providerAcceptedProspects,
    deliveredProspects: deliveredLeadIds.size,
    humanReplies,
    warmReplies,
    attributableHumanReplies,
    attributableWarmReplies,
    unattributedHumanReplies: humanReplies - attributableHumanReplies,
    unmatchedDeliveries: new Set(deliveredEvents
      .filter((row) => row.correlation_id && !acceptedProviderIds.has(row.correlation_id))
      .map((row) => row.correlation_id)).size
      + deliveredEvents.filter((row) => !row.correlation_id).length,
    deliveryRate: providerAccepted ? Number((delivered / providerAccepted * 100).toFixed(1)) : null,
    replyRate: providerAcceptedProspects
      ? Number((attributableHumanReplies / providerAcceptedProspects * 100).toFixed(1))
      : null,
    warmRate: attributableHumanReplies
      ? Number((attributableWarmReplies / attributableHumanReplies * 100).toFixed(1))
      : null,
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
