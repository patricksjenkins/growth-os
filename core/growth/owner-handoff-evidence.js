'use strict';

const { isSyntheticGrowthLead } = require('./production-evidence');

const OWNER_ACCEPTED_EVENT = 'owner_accepted_sales_handoff';
const PROVIDER_ACCEPTED_EVENTS = Object.freeze([
  'first_touch_provider_accepted',
  'sequence_touch_provider_accepted',
]);
const REPLY_EVIDENCE_EVENTS = Object.freeze([
  'human_reply_received',
  'human_reply_owner_verified',
  'warm_reply_owner_verified',
]);
const OWNER_ATTENTION_TYPES = Object.freeze([
  'sales_reply_interested',
  'sales_reply_question',
  'sales_reply_review',
]);

function firstEvent(events, predicate) {
  return (events || []).find((event) => predicate(event)) || null;
}

function summarizeSalesEvidence(events = []) {
  const providerAccepted = firstEvent(events, (event) => (
    PROVIDER_ACCEPTED_EVENTS.includes(event?.event_type)
  ));
  const canonicalReply = firstEvent(events, (event) => (
    event?.event_type === 'human_reply_received'
  ));
  const anyReply = firstEvent(events, (event) => (
    REPLY_EVIDENCE_EVENTS.includes(event?.event_type)
  ));
  const ownerAccepted = firstEvent(events, (event) => (
    event?.event_type === OWNER_ACCEPTED_EVENT
  ));
  const demoBooked = firstEvent(events, (event) => event?.event_type === 'demo_booked');

  return {
    is_outbound: Boolean(providerAccepted),
    provider_accepted_at: providerAccepted?.occurred_at || null,
    canonical_reply_at: canonicalReply?.occurred_at || null,
    reply_evidence_at: anyReply?.occurred_at || null,
    owner_accepted_at: ownerAccepted?.occurred_at || null,
    demo_booked_at: demoBooked?.occurred_at || null,
  };
}

function validateOwnerHandoffAcceptance({ lead, events = [] } = {}) {
  if (!lead) {
    return { ok: false, status: 404, code: 'lead_not_found', error: 'Lead not found.' };
  }
  if (isSyntheticGrowthLead(lead)) {
    return {
      ok: false,
      status: 403,
      code: 'synthetic_growth_lead',
      error: 'Synthetic or quarantined records cannot enter the owner handoff.',
    };
  }

  const evidence = summarizeSalesEvidence(events);
  if (evidence.owner_accepted_at) {
    return { ok: true, already_accepted: true, evidence };
  }

  const surfaced = lead.next_action_owner === 'owner'
    && Boolean(lead.handoff_at)
    && Boolean(lead.human_handoff_reason);
  if (!surfaced) {
    return {
      ok: false,
      status: 409,
      code: 'handoff_not_surfaced',
      error: 'This prospect has not been placed in Patrick\'s owner handoff queue.',
      evidence,
    };
  }

  // For an outbound prospect, only the immutable provider-connected reply
  // receipt may prove a human response. A manual stage click is useful for a
  // direct/referral lead, but it must not manufacture a reply to FGA outreach.
  const replyProven = evidence.is_outbound
    ? Boolean(evidence.canonical_reply_at)
    : Boolean(evidence.reply_evidence_at);
  if (!replyProven) {
    return {
      ok: false,
      status: 409,
      code: evidence.is_outbound ? 'canonical_reply_required' : 'reply_evidence_required',
      error: evidence.is_outbound
        ? 'A provider-connected human reply must be recorded before this outbound handoff can be accepted.'
        : 'Human-reply evidence must be recorded before this handoff can be accepted.',
      evidence,
    };
  }

  return { ok: true, already_accepted: false, evidence };
}

function validateDemoBookingEvidence(events = []) {
  const evidence = summarizeSalesEvidence(events);
  if (!evidence.is_outbound || evidence.owner_accepted_at) {
    return { ok: true, evidence };
  }
  return {
    ok: false,
    status: 409,
    code: 'owner_acceptance_required',
    error: 'Accept the verified owner handoff before recording a demo for this outbound prospect.',
    evidence,
  };
}

module.exports = {
  OWNER_ACCEPTED_EVENT,
  PROVIDER_ACCEPTED_EVENTS,
  REPLY_EVIDENCE_EVENTS,
  OWNER_ATTENTION_TYPES,
  summarizeSalesEvidence,
  validateOwnerHandoffAcceptance,
  validateDemoBookingEvidence,
};
