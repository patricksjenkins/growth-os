'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { _internal } = require('../worker/agents/chief-of-staff');

test('resolved intake automation failures do not remain Chief of Staff risks', () => {
  const jobs = [
    { agent_name: 'speed-to-lead', payload: { lead_id: 'bot' } },
    { agent_name: 'speed-to-lead', payload: { lead_id: 'real' } },
    { agent_name: 'infrastructure', payload: {} },
    { agent_name: 'outreach', error: 'deployment_interrupted_during_paused_draft_refresh', payload: {} },
  ];
  const leads = [
    { id: 'bot', metadata: { intake_safety: { contact_allowed: false } } },
    { id: 'real', metadata: { intake_safety: { contact_allowed: true } } },
  ];
  assert.deepEqual(_internal.excludeQuarantinedIntakeFailures(jobs, leads), [jobs[1], jobs[2]]);
});

test('owner decisions name the failing agent instead of showing an orphaned error count', () => {
  assert.equal(_internal.ownerDecisionTitle({
    agent_name: 'speed-to-lead',
    business_impact: 'Same error repeated 23× in 8d.',
  }), 'speed-to-lead: Same error repeated 23× in 8d.');
});

test('department coverage distinguishes live operating evidence from formal acceptance', () => {
  const coverage = _internal.summarizeDepartmentCoverage({
    departments: [
      { department: 'revenue_sales', report_state: 'missing', outcome_health: 'unknown' },
      { department: 'finance_data_governance', report_state: 'accepted', outcome_health: 'at_risk' },
      { department: 'marketing_brand', report_state: 'submitted', outcome_health: 'unknown' },
    ],
  }, {
    schema_version: 2,
    health: 'at_risk',
  });
  assert.equal(coverage.total_heads, 7);
  assert.equal(coverage.live_operating_reports, 2);
  assert.equal(coverage.formally_accepted_reports, 1);
  assert.equal(coverage.evidence_gated, 5);
  assert.equal(coverage.departments.find(row => row.department === 'revenue_sales').source, 'live_revenue_guardian_report');
});

test('current cohort counts only verified current sequence receipts and post-authorization outcomes', () => {
  const candidates = [
    { lead_id: 'a', first_touch_sequence_id: 'sa', authorized_at: '2026-09-11T08:00:00Z' },
    { lead_id: 'b', first_touch_sequence_id: 'sb', authorized_at: '2026-09-11T08:00:00Z' },
  ];
  const sequences = [
    { id: 'sa', lead_id: 'a', sequence_status: 'sent', metadata: { delivered: { provider_id: 'provider-a' } } },
    { id: 'sb', lead_id: 'wrong-lead', sequence_status: 'sent', metadata: { delivered: { provider_id: 'provider-b' } } },
  ];
  const events = [
    { lead_id: 'a', stage: 'delivered', occurred_at: '2026-09-11T08:30:00Z' },
    { lead_id: 'a', stage: 'warm', occurred_at: '2026-09-11T09:00:00Z' },
    { lead_id: 'a', stage: 'owner_accepted', occurred_at: '2026-09-11T09:30:00Z' },
    { lead_id: 'a', event_type: 'demo_booked', occurred_at: '2026-09-11T10:00:00Z' },
    { lead_id: 'b', stage: 'delivered', occurred_at: '2026-09-10T08:30:00Z' },
    { lead_id: 'outside', stage: 'warm', occurred_at: '2026-09-11T09:00:00Z' },
  ];
  assert.deepEqual(_internal.summarizeCurrentCohort(candidates, sequences, events), {
    size: 2,
    provider_accepted: 1,
    delivered: 1,
    human_reply: 1,
    warm_reply: 1,
    owner_accepted: 1,
    demo_booked: 1,
  });
});
