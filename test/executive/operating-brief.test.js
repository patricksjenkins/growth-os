'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildOperatingBrief } = require('../../core/executive/operating-brief');

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
  });
  assert.match(brief.headline, /need Patrick/);
  assert.equal(brief.owner_interface.relationship_moments[0].company, 'Acme');
  assert.equal(brief.outcomes_30d.demo_booked, 1);
  assert.equal(brief.owner_interface.commitments[0].state, 'met');
  assert.equal(brief.current_plan.state, 'in_progress');
  assert.equal(brief.current_plan.authorized_remaining, 20);
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
    revenueDepartment: { schema_version: 2, health: 'at_risk', outcomes_30d: {}, reasons: ['first_touch_behind_checkpoint'] },
  });
  assert.equal(brief.owner_interface.commitments[0].state, 'missed');
  assert.deepEqual(brief.owner_interface.decisions, []);
  assert.equal(brief.department_health, 'at_risk');
  assert.equal(brief.current_plan.state, 'scheduled');
  assert.ok(brief.owner_interface.material_risks.some((risk) => risk.code === 'daily_first_touch_missed'));
});
