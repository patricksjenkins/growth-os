'use strict';

const { PLAN_KEY, OUTCOME_LADDER } = require('../growth/seven-touch-plan');

const SALES_DEPARTMENT = Object.freeze({
  id: 'revenue_sales',
  name: 'Revenue & Sales',
  head: Object.freeze({
    role: 'Chief Revenue Agent',
    agent: 'revenue-guardian',
    reports_to: 'chief-of-staff',
    execution_mode: 'supervised_with_bounded_remediation',
  }),
  mission: 'Create qualified human sales conversations from a broad small-business market, move warm interest to a demo-ready owner handoff, and prove every outcome with durable evidence.',
  teams: Object.freeze([
    Object.freeze({
      name: 'Prospect Supply',
      members: Object.freeze(['prospecting-orchestrator', 'prospecting', 'enrichment', 'scoring', 'targeted-campaign', 'facebook-prospecting']),
      owns: 'Existing-inventory prioritization, new discovery, contact evidence, qualification, and ranking.',
    }),
    Object.freeze({
      name: 'Outreach Conversation',
      members: Object.freeze(['outreach', 'auto-outreach', 'drip-campaign', 'reply-classification']),
      owns: 'Provider-gated first touch, seven-touch follow-up, delivery evidence, reply detection, and stop rules.',
    }),
    Object.freeze({
      name: 'Conversion & Handoff',
      members: Object.freeze(['sales-nurture', 'owner-handoff']),
      owns: 'Warm-reply acceptance, demo progression, proposal evidence, and won/lost outcome continuity.',
    }),
  ]),
  kpis: Object.freeze([
    'safe_contactable_inventory',
    'first_touch_provider_accepted',
    'delivery_rate',
    'human_reply_rate',
    'warm_reply_rate',
    'owner_acceptance_rate',
    'demo_booked_rate',
    'demo_held_rate',
    'proposal_rate',
    'win_rate',
  ]),
  authority: Object.freeze({
    allowed: Object.freeze([
      'observe', 'rank_prospects', 'queue_bounded_internal_work',
      'verify_evidence', 'run_existing_gated_sender', 'raise_exception',
    ]),
    prohibited: Object.freeze([
      'bypass_send_gate', 'contact_customer_tenant', 'contact_existing_customer',
      'alter_pricing', 'move_money', 'invent_conversion', 'close_own_evidence_gap',
    ]),
  }),
  report_contract: Object.freeze({
    plan_key: PLAN_KEY,
    outcome_ladder: OUTCOME_LADDER,
    recipient: 'chief-of-staff',
    contains_contact_data: false,
  }),
});

function buildSalesDepartmentReport({
  asOf,
  reportingDate,
  target,
  sentToday,
  expected,
  inventory = {},
  outcomes30d = {},
  campaignReady,
  replySyncFresh,
  deliverabilityPaused,
  anomalies = [],
  blockers = {},
} = {}) {
  const reasons = [];
  if (!campaignReady) reasons.push('canonical_campaign_not_active');
  if (!replySyncFresh) reasons.push('reply_sync_not_fresh');
  if (deliverabilityPaused) reasons.push('deliverability_paused');
  if (anomalies.length) reasons.push('funnel_evidence_inconsistent');
  if (Number(sentToday || 0) < Number(expected || 0)) reasons.push('first_touch_behind_checkpoint');
  if (Number(inventory.sendReady || 0) === 0) reasons.push('no_send_ready_inventory');

  let health = 'healthy';
  if (reasons.some((reason) => [
    'canonical_campaign_not_active', 'reply_sync_not_fresh',
    'deliverability_paused', 'funnel_evidence_inconsistent',
  ].includes(reason))) health = 'unhealthy';
  else if (reasons.length) health = 'at_risk';

  const normalizedOutcomes = Object.fromEntries(OUTCOME_LADDER.map((stage) => (
    [stage, Number(outcomes30d[stage] || 0)]
  )));
  const rate = (numerator, denominator) => (
    denominator > 0 ? Number((numerator * 100 / denominator).toFixed(1)) : null
  );

  return {
    schema_version: 2,
    department: SALES_DEPARTMENT.id,
    department_name: SALES_DEPARTMENT.name,
    head: SALES_DEPARTMENT.head,
    mission: SALES_DEPARTMENT.mission,
    reporting_date: reportingDate,
    as_of: asOf,
    health,
    reasons,
    plan_key: PLAN_KEY,
    daily_commitment: {
      target: Number(target || 0),
      provider_accepted: Number(sentToday || 0),
      expected_by_now: Number(expected || 0),
    },
    inventory: {
      prospects: Number(inventory.prospects || inventory.totalLeads || inventory.total || 0),
      with_email: Number(inventory.withEmail || 0),
      scored: Number(inventory.scored || 0),
      send_ready: Number(inventory.sendReady || 0),
      quality_failed: Number(inventory.draftsQualityFailed || 0),
    },
    outcomes_30d: normalizedOutcomes,
    conversion_30d: {
      delivery_rate: rate(normalizedOutcomes.delivered, normalizedOutcomes.provider_accepted),
      human_reply_rate: rate(normalizedOutcomes.human_reply, normalizedOutcomes.delivered),
      warm_reply_rate: rate(normalizedOutcomes.warm_reply, normalizedOutcomes.human_reply),
      owner_acceptance_rate: rate(normalizedOutcomes.owner_accepted, normalizedOutcomes.warm_reply),
      demo_booked_rate: rate(normalizedOutcomes.demo_booked, normalizedOutcomes.owner_accepted),
      demo_held_rate: rate(normalizedOutcomes.demo_held, normalizedOutcomes.demo_booked),
      proposal_rate: rate(normalizedOutcomes.proposal, normalizedOutcomes.demo_held),
      win_rate: rate(normalizedOutcomes.won, normalizedOutcomes.proposal),
    },
    controls: {
      campaign_ready: Boolean(campaignReady),
      reply_sync_fresh: Boolean(replySyncFresh),
      deliverability_paused: Boolean(deliverabilityPaused),
      active_blockers: Object.keys(blockers || {}).filter((key) => blockers[key]),
      anomaly_count: anomalies.length,
    },
    authority: SALES_DEPARTMENT.authority,
    reports_to: SALES_DEPARTMENT.head.reports_to,
    contains_contact_data: false,
  };
}

module.exports = { SALES_DEPARTMENT, buildSalesDepartmentReport };
