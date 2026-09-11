'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { _internal } = require('../worker/agents/chief-of-staff');

test('resolved intake automation failures do not remain Chief of Staff risks', () => {
  const jobs = [
    { agent_name: 'speed-to-lead', payload: { lead_id: 'bot' } },
    { agent_name: 'speed-to-lead', payload: { lead_id: 'real' } },
    { agent_name: 'infrastructure', payload: {} },
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
