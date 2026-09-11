'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  summarizeSalesEvidence,
  validateOwnerHandoffAcceptance,
  validateDemoBookingEvidence,
} = require('../../core/growth/owner-handoff-evidence');

const surfacedLead = {
  id: 'lead-1',
  status: 'interested',
  next_action_owner: 'owner',
  next_best_action: 'sales_call',
  handoff_at: '2026-09-11T12:00:00Z',
  human_handoff_reason: 'drip_reply',
  lead_source: 'prospecting_agent',
  metadata: {},
};

const event = (event_type, occurred_at, stage = null) => ({ event_type, occurred_at, stage });

test('an outbound handoff requires the provider-connected human reply receipt', () => {
  const onlyManualAssertion = [
    event('first_touch_provider_accepted', '2026-09-10T12:00:00Z', 'provider_accepted'),
    event('warm_reply_owner_verified', '2026-09-11T12:00:00Z', 'warm'),
  ];
  const rejected = validateOwnerHandoffAcceptance({ lead: surfacedLead, events: onlyManualAssertion });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'canonical_reply_required');

  const accepted = validateOwnerHandoffAcceptance({
    lead: surfacedLead,
    events: [...onlyManualAssertion, event('human_reply_received', '2026-09-11T11:55:00Z', 'warm')],
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.already_accepted, false);
});

test('a direct or referral lead can use owner-verified reply evidence', () => {
  const result = validateOwnerHandoffAcceptance({
    lead: { ...surfacedLead, lead_source: 'referral' },
    events: [event('human_reply_owner_verified', '2026-09-11T12:00:00Z', 'human_reply')],
  });
  assert.equal(result.ok, true);
});

test('owner acceptance cannot be created from a missing handoff or synthetic lead', () => {
  const reply = [event('human_reply_received', '2026-09-11T12:00:00Z', 'warm')];
  assert.equal(validateOwnerHandoffAcceptance({
    lead: { ...surfacedLead, handoff_at: null }, events: reply,
  }).code, 'handoff_not_surfaced');
  assert.equal(validateOwnerHandoffAcceptance({
    lead: { ...surfacedLead, metadata: { synthetic: true } }, events: reply,
  }).code, 'synthetic_growth_lead');
});

test('an existing acceptance is idempotently recognized', () => {
  const result = validateOwnerHandoffAcceptance({
    lead: surfacedLead,
    events: [event('owner_accepted_sales_handoff', '2026-09-11T12:05:00Z', 'owner_accepted')],
  });
  assert.equal(result.ok, true);
  assert.equal(result.already_accepted, true);
  assert.equal(result.evidence.owner_accepted_at, '2026-09-11T12:05:00Z');
});

test('an outbound demo is blocked until explicit owner acceptance exists', () => {
  const outbound = [event('first_touch_provider_accepted', '2026-09-10T12:00:00Z', 'provider_accepted')];
  const blocked = validateDemoBookingEvidence(outbound);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'owner_acceptance_required');

  assert.equal(validateDemoBookingEvidence([
    ...outbound,
    event('owner_accepted_sales_handoff', '2026-09-11T12:00:00Z', 'owner_accepted'),
  ]).ok, true);
  assert.equal(validateDemoBookingEvidence([]).ok, true, 'direct/manual pipeline remains backward compatible');
});

test('sales evidence summary keeps acceptance and demo as distinct timestamps', () => {
  const summary = summarizeSalesEvidence([
    event('owner_accepted_sales_handoff', '2026-09-11T12:00:00Z', 'owner_accepted'),
    event('demo_booked', '2026-09-11T13:00:00Z'),
  ]);
  assert.equal(summary.owner_accepted_at, '2026-09-11T12:00:00Z');
  assert.equal(summary.demo_booked_at, '2026-09-11T13:00:00Z');
});
