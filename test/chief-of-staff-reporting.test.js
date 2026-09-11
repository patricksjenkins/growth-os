'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { _internal } = require('../worker/agents/chief-of-staff');

test('Chief of Staff schedule is exact-FGA and cannot silently depend on a missing module', () => {
  const source = fs.readFileSync(path.join(__dirname, '../worker/scheduler/cron.js'), 'utf8');
  const line = source.split('\n').find((row) => row.includes("agent: 'chief-of-staff'"));
  assert.ok(line, 'Chief of Staff cron must exist');
  assert.match(line, /module: '\*'/, 'FGA internal briefing must not depend on email_chief');
  assert.match(line, /when: \(t\) => isFGAlike\(t\)/, 'customer tenants must remain excluded');
  assert.doesNotMatch(line, /email_chief/);
});

test('each Chief of Staff brief is preceded by a fresh FGA Growth snapshot', () => {
  const source = fs.readFileSync(path.join(__dirname, '../worker/scheduler/cron.js'), 'utf8');
  const lines = source.split('\n');
  const growth = lines.find((row) => row.includes("agent: 'prospecting-orchestrator'"));
  const chief = lines.find((row) => row.includes("agent: 'chief-of-staff'"));
  assert.ok(growth, 'Growth snapshot schedule must exist');
  assert.ok(chief, 'Chief of Staff schedule must exist');
  assert.match(growth, /cron: '55 7,11,16 \* \* \*'/);
  assert.match(chief, /cron: '0 8,12,17 \* \* \*'/);
  assert.match(growth, /when: \(t\) => isFGAlike\(t\)/,
    'fresh executive evidence must remain exact-FGA');
});

test('required Revenue evidence cannot degrade into a confident empty result', () => {
  assert.deepEqual(
    _internal.requireEvidenceRead({ data: { inventory: { sendReady: 25 } }, error: null }, 'funnel'),
    { inventory: { sendReady: 25 } },
  );
  assert.throws(
    () => _internal.requireEvidenceRead({ data: null, error: new Error('offline') }, 'funnel'),
    /funnel_read_failed/,
  );

  const source = fs.readFileSync(path.join(__dirname, '../worker/agents/chief-of-staff.js'), 'utf8');
  assert.doesNotMatch(source, /\(\) => \(\{ inventory: \{\}, anomalies: \[\] \}\)/);
  assert.doesNotMatch(source, /\.then\(\(r\) => r\.data \|\| \[\], \(\) => \[\]\)/);
  for (const warning of [
    'approved_content_read_failed',
    'recent_posts_read_failed',
    'content_stats_read_failed',
    'agent_activity_read_failed',
    'department_coverage_read_failed',
  ]) assert.match(source, new RegExp(warning));
});

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

test('a later successful FGA execution resolves the matching failure without erasing history', () => {
  const jobs = [
    { agent_name: 'supervised-executive-foundation', status: 'failed', payload: {}, completed_at: '2026-09-11T10:00:00Z' },
    { agent_name: 'supervised-executive-foundation', status: 'failed', payload: {}, completed_at: '2026-09-11T10:05:00Z' },
    { agent_name: 'supervised-executive-foundation', status: 'completed', payload: {}, completed_at: '2026-09-11T10:10:00Z' },
    { agent_name: 'drip-campaign', status: 'failed', payload: { task: 'sync_replies' }, completed_at: '2026-09-11T10:15:00Z' },
    { agent_name: 'drip-campaign', status: 'completed', payload: { task: 'send_due' }, completed_at: '2026-09-11T10:20:00Z' },
    { agent_name: 'enrichment', status: 'failed', payload: { lead_id: 'lead-a' }, completed_at: '2026-09-11T10:25:00Z' },
    { agent_name: 'enrichment', status: 'completed', payload: { lead_id: 'lead-b' }, completed_at: '2026-09-11T10:30:00Z' },
  ];
  assert.deepEqual(
    _internal.excludeRecoveredExecutionFailures(jobs),
    [jobs[3], jobs[5]],
  );
  assert.equal(_internal.executionAttemptKey(jobs[3]), 'drip-campaign:task:sync_replies');
  assert.equal(_internal.executionAttemptKey(jobs[4]), 'drip-campaign:task:send_due');
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
    persisted_at: '2026-09-11T09:00:00Z',
  });
  assert.equal(coverage.total_heads, 7);
  assert.equal(coverage.live_operating_reports, 2);
  assert.equal(coverage.formally_accepted_reports, 1);
  assert.equal(coverage.evidence_gated, 5);
  assert.equal(coverage.departments.find(row => row.department === 'revenue_sales').source, 'live_revenue_guardian_report');
  assert.equal(coverage.departments.find(row => row.department === 'revenue_sales').updated_at, '2026-09-11T09:00:00Z');
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
  assert.deepEqual(_internal.acceptedCurrentCohortStarts(candidates, sequences), [
    { lead_id: 'a', sequence_id: 'sa' },
  ]);
});

test('current cohort never reports a downstream milestone without its prerequisites', () => {
  const candidates = [
    { lead_id: 'a', first_touch_sequence_id: 'sa', authorized_at: '2026-09-11T08:00:00Z' },
    { lead_id: 'b', first_touch_sequence_id: 'sb', authorized_at: '2026-09-11T08:00:00Z' },
  ];
  const sequences = [
    { id: 'sa', lead_id: 'a', sequence_status: 'sent', metadata: { delivered: { provider_id: 'provider-a' } } },
    { id: 'sb', lead_id: 'b', sequence_status: 'sent', metadata: { delivered: { provider_id: 'provider-b' } } },
  ];
  const events = [
    // A reply proves delivery, so A may advance without a separate delivered webhook.
    { lead_id: 'a', stage: 'warm', occurred_at: '2026-09-11T09:00:00Z' },
    { lead_id: 'a', event_type: 'demo_booked', occurred_at: '2026-09-11T10:00:00Z' },
    // B has owner acceptance but no reply; that cannot enter the funnel either.
    { lead_id: 'b', stage: 'owner_accepted', occurred_at: '2026-09-11T09:30:00Z' },
  ];
  assert.deepEqual(_internal.summarizeCurrentCohort(candidates, sequences, events), {
    size: 2,
    provider_accepted: 2,
    delivered: 1,
    human_reply: 1,
    warm_reply: 1,
    owner_accepted: 0,
    demo_booked: 0,
  });
});
