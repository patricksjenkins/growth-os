'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildOperatingBrief, numberOrNull } = require('../../core/executive/operating-brief');

test('missing measurements stay unknown instead of coercing to zero', () => {
  assert.equal(numberOrNull(null), null);
  assert.equal(numberOrNull(undefined), null);
  assert.equal(numberOrNull(''), null);
  assert.equal(numberOrNull(0), 0);
});

test('Chief of Staff leads with relationship moments and demo outcomes', () => {
  const brief = buildOperatingBrief({
    revenueOutcome: {
      target: 25,
      last_business_day: { et_date: '2026-09-09', sent: 25, met: true },
      today: { et_date: '2026-09-10', sent: 5, expected_by_now: 5 },
      restart_cohort: { plan_key: 'database-first-seven-touch-v2', authorized_remaining: 20, provider_accepted: 5 },
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
      funnel: { high_score: 80 },
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
  assert.equal(brief.schema_version, 3);
  assert.equal(brief.path_to_demo[0].actual, 80);
  assert.equal(brief.agent_owned_work[0].owner, 'auto-outreach');
  assert.equal(brief.agent_owned_work[1].owner, 'enrichment');
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
  assert.ok(brief.owner_interface.material_risks.some((risk) => risk.code === 'daily_first_touch_missed'));
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
      restart_cohort: { authorized_remaining: 25 },
      sequence_continuity: { active: 5, eligible_remaining: 411 },
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
  assert.equal(brief.path_to_demo.find(row => row.key === 'seven_touch_active').actual, 5);
  assert.equal(brief.agent_owned_work[0].owner, 'sequence-recovery');
  assert.ok(brief.owner_interface.material_risks.some(row => row.code === 'seven_touch_continuity_backlog'));
});
