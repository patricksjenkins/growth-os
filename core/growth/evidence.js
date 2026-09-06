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

module.exports = { ACCEPTED_EVENT_TYPES, providerOutcomeMetrics, pipelineEvidenceCoverage };
