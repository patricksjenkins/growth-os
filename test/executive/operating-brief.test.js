'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildOperatingBrief, numberOrNull } = require('../../core/executive/operating-brief');
const { _internal: chiefOfStaff } = require('../../worker/agents/chief-of-staff');

test('missing measurements stay unknown instead of coercing to zero', () => {
  assert.equal(numberOrNull(null), null);
  assert.equal(numberOrNull(undefined), null);
  assert.equal(numberOrNull(''), null);
  assert.equal(numberOrNull(0), 0);
});

test('Chief of Staff leads with relationship moments and demo outcomes', () => {
  const deliveryLifecycle = {
    available: true, accepted: 5, observed: 5, terminal: 4,
    delivered: 4, delayed: 1, sent: 0, suppressed: 0,
    bounced: 0, complained: 0, failed: 0, unknown: 0,
    pending: 1, evidence_complete: true, reason: null,
  };
  const brief = buildOperatingBrief({
    revenueOutcome: {
      target: 25,
      ready_to_send: 40,
      last_business_day: { et_date: '2026-09-09', sent: 25, met: true },
      today: {
        et_date: '2026-09-10', sent: 5, expected_by_now: 5,
        delivery_lifecycle: deliveryLifecycle,
        employee_evidence: {
          available: true, cohort: 5, source_confirmed: 2, estimated: 3,
          sweet_spot_1_9: 5, accepted_10_19: 0, outside_policy: 0, unknown: 0,
        },
      },
      restart_cohort: { plan_key: 'database-first-seven-touch-v2', authorized_remaining: 20, provider_accepted: 5 },
      current_cohort: { size: 25, provider_accepted: 5, delivered: 4, human_reply: 1, warm_reply: 1, owner_accepted: 1, demo_booked: 0 },
      funnel_anomalies: [],
      open_reliability_handoffs: [],
    },
    revenueDepartment: {
      schema_version: 2,
      health: 'healthy',
      outcomes_30d: { delivered: 80, human_reply: 6, warm_reply: 2, owner_accepted: 2, demo_booked: 1, demo_held: 1, proposal: 1, won: 0 },
    },
    relationshipMoments: [{ id: 'lead-1', company_name: 'Acme', status: 'interested', next_best_action: 'sales_call' }],
    growthSnapshot: {
      snapshot_at: '2026-09-10T10:00:00.000Z',
      funnel: { high_score: 80, email_ready: 12 },
      next_actions: [{ id: 'review_no_contact', label: 'Review 12 prospects', count: 12, link: '/admin/pipeline' }],
    },
  });
  assert.match(brief.headline, /need Patrick/);
  assert.equal(brief.owner_interface.relationship_moments[0].company, 'Acme');
  assert.equal(brief.outcomes_30d.demo_booked, 1);
  assert.equal(brief.owner_interface.commitments[0].state, 'met');
  assert.equal(brief.owner_interface.commitments[1].state, 'observed');
  assert.equal(brief.current_plan.state, 'in_progress');
  assert.equal(brief.current_plan.authorized_remaining, 20);
  assert.deepEqual(brief.current_plan.delivery_lifecycle, deliveryLifecycle);
  assert.equal(brief.schema_version, 3);
  assert.equal(brief.path_to_demo[0].actual, 25);
  assert.equal(brief.path_to_demo[0].key, 'current_cohort');
  assert.equal(brief.current_plan.next_cohort_email_ready, 40);
  assert.equal(brief.current_plan.employee_evidence.source_confirmed, 2);
  assert.equal(brief.path_to_demo.find(row => row.key === 'delivered').actual, 4);
  assert.equal(brief.path_to_demo.some(row => row.key === 'email_ready_inventory'), false);
  assert.equal(brief.agent_owned_work[0].owner, 'auto-outreach');
  assert.equal(brief.agent_owned_work[1].owner, 'enrichment');

  const digest = chiefOfStaff.formatDigest({
    operating_brief: brief,
    departments: { revenue_sales: { plan_key: 'database-first-seven-touch-v2' } },
  }, 'First Gen Automate');
  assert.match(digest, /Delivery evidence: 4 delivered · 1 delayed · 0 suppressed/);
  assert.match(digest, /Employee-size evidence: 2 source-confirmed · 3 explicitly estimated · 5 in 1–9/);
});

test('accepted sends with unreadable employee evidence become a material risk, never a confident zero', () => {
  const brief = buildOperatingBrief({
    revenueOutcome: {
      target: 25,
      today: {
        sent: 5, expected_by_now: 5,
        employee_evidence: {
          available: false, cohort: 5, source_confirmed: null, estimated: null,
          sweet_spot_1_9: null, accepted_10_19: null, outside_policy: null,
          unknown: null, reason: 'lead_employee_evidence_read_failed',
        },
      },
    },
    revenueDepartment: { schema_version: 2, health: 'healthy', outcomes_30d: {} },
  });
  assert.equal(brief.current_plan.employee_evidence.source_confirmed, null);
  assert.ok(brief.owner_interface.material_risks.some(
    (risk) => risk.code === 'accepted_cohort_employee_evidence_unavailable',
  ));
  const digest = chiefOfStaff.formatDigest({
    operating_brief: brief,
    departments: { revenue_sales: {} },
  }, 'First Gen Automate');
  assert.match(digest, /Employee-size evidence: UNAVAILABLE/);
});

test('Chief of Staff says delivery is unavailable instead of converting acceptance to delivery', () => {
  const brief = buildOperatingBrief({
    revenueOutcome: {
      target: 25,
      today: {
        sent: 25,
        expected_by_now: 25,
        delivery_lifecycle: {
          available: false, accepted: 25, delivered: null, delayed: null,
          suppressed: null, bounced: null, complained: null, failed: null,
          unknown: null, evidence_complete: false,
        },
      },
      restart_cohort: { authorized_remaining: 0 },
    },
    revenueDepartment: { schema_version: 2, health: 'healthy', outcomes_30d: {} },
  });
  const digest = chiefOfStaff.formatDigest({
    operating_brief: brief,
    departments: { revenue_sales: { plan_key: 'database-first-seven-touch-v2' } },
  }, 'First Gen Automate');
  assert.match(digest, /Delivery evidence: UNAVAILABLE/);
  assert.match(digest, /acceptance must not be treated as delivery/);
});

test('Chief of Staff never turns unavailable evidence into a confident zero', () => {
  const brief = buildOperatingBrief({
    evidenceWarnings: ['lead_pipeline_read_failed'],
  });
  assert.equal(brief.outcomes_30d.delivered, null);
  assert.equal(brief.outcomes_30d.human_reply, null);
  assert.equal(brief.owner_interface.commitments[0].state, 'unknown');
  assert.equal(brief.department_health, 'unknown');
  assert.ok(brief.owner_interface.material_risks.some((risk) => risk.code === 'revenue_department_unverified'));
  assert.ok(brief.owner_interface.material_risks.some((risk) => risk.code === 'lead_pipeline_read_failed'));
  assert.equal(brief.path_to_demo[0].actual, null);
});

test('missed send commitment is reported as system performance, not invented owner work', () => {
  const brief = buildOperatingBrief({
    revenueOutcome: {
      target: 25,
      last_business_day: { et_date: '2026-09-09', sent: 0, met: false },
      today: { et_date: '2026-09-10', sent: 0, expected_by_now: 0 },
      restart_cohort: { plan_key: 'database-first-seven-touch-v2', authorized_remaining: 25, provider_accepted: 0 },
      funnel_anomalies: [],
      open_reliability_handoffs: [],
    },
    revenueDepartment: { schema_version: 2, health: 'at_risk', outcomes_30d: { demo_booked: 0 }, reasons: ['first_touch_behind_checkpoint'] },
  });
  assert.equal(brief.owner_interface.commitments[0].state, 'missed');
  assert.equal(brief.owner_interface.commitments[1].state, 'not_observed');
  assert.deepEqual(brief.owner_interface.decisions, []);
  assert.equal(brief.department_health, 'at_risk');
  assert.equal(brief.current_plan.state, 'scheduled');
  assert.ok(brief.owner_interface.material_risks.some((risk) => risk.code === 'daily_sequence_start_missed'));
});

test('non-sales approvals remain visible without posing as demo-path owner work', () => {
  const brief = buildOperatingBrief({
    asOf: '2026-09-11T06:00:00.000Z',
    revenueOutcome: {
      target: 25,
      last_business_day: { et_date: '2026-09-10', sent: 25, met: true },
      today: { sent: 0, expected_by_now: 0 },
      restart_cohort: { authorized_remaining: 25 },
    },
    revenueDepartment: { schema_version: 2, health: 'healthy', outcomes_30d: {} },
    otherApprovals: [{ id: 'content', type: 'content_approval', title: '2 content drafts require approval', count: 2 }],
  });
  assert.deepEqual(brief.owner_interface.decisions, []);
  assert.equal(brief.owner_interface.other_approvals[0].count, 2);
  assert.match(brief.headline, /25 authorized prospects/);
  assert.equal(brief.current_plan.next_checkpoint.owner, 'auto-outreach');
});

test('agent failures are bounded to an accountable 24-hour, by-agent risk', () => {
  const brief = buildOperatingBrief({
    revenueDepartment: { schema_version: 2, health: 'healthy', outcomes_30d: {} },
    failedJobs: [
      { agent_name: 'speed-to-lead' },
      { agent_name: 'speed-to-lead' },
      { agent_name: 'scoring' },
    ],
  });
  const risk = brief.owner_interface.material_risks.find((row) => row.code === 'recent_agent_failures');
  assert.ok(risk);
  assert.match(risk.message, /last 24 hours/);
  assert.match(risk.message, /speed-to-lead 2/);
  assert.match(risk.message, /scoring 1/);
});

test('Chief of Staff exposes seven-touch continuity instead of celebrating first-touch volume', () => {
  const brief = buildOperatingBrief({
    revenueOutcome: {
      target: 25,
      last_business_day: { et_date: '2026-09-10', sent: 25, met: true },
      today: { sent: 0, expected_by_now: 0 },
      restart_cohort: { authorized_remaining: 0 },
      current_cohort: { size: 25, provider_accepted: 25, delivered: 25, human_reply: 0, warm_reply: 0, owner_accepted: 0, demo_booked: 0 },
      sequence_continuity: { active: 5, eligible_remaining: 411, recovered_today: 5, daily_limit: 5, remaining_today: 0 },
    },
    revenueDepartment: {
      schema_version: 2,
      health: 'healthy',
      outcomes_30d: { delivered: 494, human_reply: 0, warm_reply: 0, demo_booked: 0 },
    },
    growthSnapshot: { funnel: { high_score: 876 }, next_actions: [] },
  });

  assert.match(brief.headline, /5 current follow-up sequences active/);
  assert.match(brief.headline, /411 provider-proven contacts await recovery/);
  assert.equal(brief.current_plan.active_followup_sequences, 5);
  assert.equal(brief.current_plan.followup_recovered_today, 5);
  assert.equal(brief.current_plan.followup_recovery_daily_limit, 5);
  assert.equal(brief.current_plan.followup_recovery_remaining_today, 0);
  assert.equal(brief.path_to_demo.some(row => row.key === 'seven_touch_active'), false);
  assert.equal(brief.agent_owned_work[0].owner, 'sequence-recovery');
  assert.match(brief.agent_owned_work[0].label, /5\/5 safely admitted today/);
  assert.ok(brief.owner_interface.material_risks.some(row => row.code === 'seven_touch_continuity_backlog'));
});

test('Chief of Staff surfaces a rejected employee-evidence provider without inventing a prospect outcome', () => {
  const brief = buildOperatingBrief({
    revenueDepartment: {
      schema_version: 2,
      health: 'healthy',
      outcomes_30d: {},
    },
    growthSnapshot: {
      funnel: {
        provider_health: {
          apollo: { status: 'credential_rejected', attempts: 6, verified: 0 },
        },
      },
    },
  });
  const risk = brief.owner_interface.material_risks.find(
    (row) => row.code === 'employee_evidence_provider_unavailable',
  );
  assert.ok(risk);
  assert.equal(risk.severity, 'high');
  assert.equal(brief.outcomes_30d.human_reply, null, 'missing reply evidence stays unknown');
  assert.match(risk.message, /No organization evidence provider is usable/i);
});

test('Chief of Staff does not report provider outage when the Apify fallback is proven', () => {
  const brief = buildOperatingBrief({
    revenueDepartment: { schema_version: 2, health: 'healthy', outcomes_30d: {} },
    growthSnapshot: {
      funnel: {
        provider_health: {
          apollo: { status: 'credential_rejected', attempts: 6, verified: 0 },
          apify: { status: 'ready', attempts: 6, verified: 2 },
        },
      },
    },
  });
  assert.equal(brief.owner_interface.material_risks.some(
    (row) => row.code === 'employee_evidence_provider_unavailable',
  ), false);
});

test('paused sending is explicit and cannot pose as a scheduled dispatch', () => {
  const brief = buildOperatingBrief({
    revenueOutcome: {
      target: 25,
      last_business_day: { et_date: '2026-09-10', sent: 25, met: true },
      today: { sent: 0, expected_by_now: 0 },
      restart_cohort: { authorized_remaining: 25 },
      current_cohort: { size: 25, provider_accepted: 0, delivered: 0, human_reply: 0, warm_reply: 0, owner_accepted: 0, demo_booked: 0 },
      controls: { first_touch_paused: true, followups_paused: true },
      creative: { version: 'conversation-first-touch-v1', drafts: 15 },
    },
    revenueDepartment: { schema_version: 2, health: 'healthy', outcomes_30d: {} },
  });
  assert.equal(brief.current_plan.state, 'paused');
  assert.equal(brief.current_plan.next_checkpoint.owner, 'revenue-head');
  assert.equal(brief.current_plan.conversation_first_drafts, 15);
  assert.equal(brief.path_to_demo.find(row => row.key === 'provider_accepted').state, 'paused');
  assert.match(brief.headline, /held for draft verification/);
  assert.match(brief.agent_owned_work[0].label, /Hold 25/);
});

test('agent-owned work contains one accountable item per work contract', () => {
  const brief = buildOperatingBrief({
    revenueOutcome: {
      target: 25,
      last_business_day: { sent: 25, met: true },
      today: { sent: 0, expected_by_now: 0 },
      restart_cohort: { authorized_remaining: 25 },
      sequence_continuity: { active: 5, eligible_remaining: 236 },
    },
    revenueDepartment: { schema_version: 2, health: 'healthy', outcomes_30d: {} },
    growthSnapshot: {
      funnel: { email_ready: 21 },
      next_actions: [{ id: 'recover_sequence_continuity', label: 'duplicate source row', count: 236 }],
    },
  });
  assert.equal(brief.agent_owned_work.filter(row => row.id === 'recover_sequence_continuity').length, 1);
});
