'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { makeDb } = require('./_stub');
const O = require('../../core/growth/orchestrator');
const { FGA_TENANT_ID } = require('../../core/config');

test('currentWeekStart — YYYY-MM-DD Monday', () => {
  assert.match(O.currentWeekStart(), /^\d{4}-\d{2}-\d{2}$/);
});

test('recovery backlog treats dry-run evidence as unwritten inventory', () => {
  assert.equal(O.recoveryBacklogCount({ dry_run: true, eligible: 236, would_enroll: 5, deferred: 231 }), 236);
  assert.equal(O.recoveryBacklogCount({ dry_run: false, eligible: 241, enrolled: 5, deferred: 236 }), 236);
  assert.equal(O.recoveryBacklogCount({ dry_run: true, eligible: 'unknown' }), null);
  assert.equal(O.recoveryBacklogCount(null), null);
});

test('recovery progress normalizes completed, cap-reached, and unavailable evidence', () => {
  assert.deepEqual(O.recoveryBudgetProgress({
    recovery_budget: { daily_limit: 5, recovered_today: 0, remaining: 5, recovered_after_run: 5, remaining_after_run: 0 },
  }), { daily_limit: 5, recovered_today: 5, remaining_today: 0 });
  assert.deepEqual(O.recoveryBudgetProgress({
    recovery_budget: { daily_limit: 5, recovered_today: 5, remaining: 0 },
  }), { daily_limit: 5, recovered_today: 5, remaining_today: 0 });
  assert.deepEqual(O.recoveryBudgetProgress(null), {
    daily_limit: null, recovered_today: null, remaining_today: null,
  });
});

test('employee-evidence provider health is receipt-backed and credential failures surface', () => {
  assert.deepEqual(O.providerEvidenceHealth({
    provider_evidence_statuses: { domain_missing: 19, credential_rejected: 6 },
  }, '2026-09-11T18:14:35.918Z'), {
    status: 'credential_rejected',
    checked_at: '2026-09-11T18:14:35.918Z',
    attempts: 25,
    verified: 0,
  });
  assert.equal(O.providerEvidenceHealth({
    provider_evidence_statuses: { verified: 3, domain_missing: 2 },
  }).status, 'ready');
  assert.equal(O.providerEvidenceHealth(null).status, 'unknown');

  const dualReceipt = {
    employee_evidence_provider_receipts: {
      apollo: { statuses: { credential_rejected: 5 } },
      apify: { statuses: { verified: 2, domain_mismatch: 3 } },
    },
  };
  assert.deepEqual(O.providerEvidenceHealth(dualReceipt, '2026-09-11T20:00:00.000Z', 'apify'), {
    status: 'ready',
    checked_at: '2026-09-11T20:00:00.000Z',
    attempts: 5,
    verified: 2,
  });

  const alerts = O.deriveAlerts({
    awaiting_scoring: 0, drafts_to_review: 0, new_this_week: 1,
    provider_health: { apollo: { status: 'credential_rejected', attempts: 6 } },
  }, []);
  assert.ok(alerts.some((alert) => alert.id === 'employee_evidence_provider_unavailable'));

  const fallbackHealthy = O.deriveAlerts({
    awaiting_scoring: 0, drafts_to_review: 0, new_this_week: 1,
    provider_health: {
      apollo: { status: 'credential_rejected', attempts: 6 },
      apify: { status: 'ready', attempts: 6, verified: 2 },
    },
  }, []);
  assert.equal(fallbackHealthy.some((alert) => alert.id === 'employee_evidence_provider_unavailable'), false,
    'one verified provider prevents a false unavailable alert');
});

test('deriveFocus — reads prospecting rotation config', () => {
  const tenant = { config: {
    prospecting_active_industries: '["tree service","junk removal"]',
    target_states: '["FL","GA","TX"]',
    weekly_prospect_target: '50',
    prospecting_icp_notes: 'Owner-operated, no website',
  } };
  const f = O.deriveFocus(tenant);
  assert.strictEqual(f.vertical, 'tree service, junk removal');
  assert.ok(f.geography.includes('FL'));
  assert.strictEqual(f.angle, 'Owner-operated, no website');
});

test('deriveAlerts — backlog, drafts, no-prospects, incidents', () => {
  const alerts = O.deriveAlerts(
    { awaiting_scoring: 40, drafts_to_review: 20, new_this_week: 0 },
    [{ agent_name: 'enrichment', issue_type: 'consecutive_failures', severity: 'red', business_impact: 'stalled' }],
  );
  const ids = alerts.map((a) => a.id);
  assert.ok(ids.includes('enrichment_backlog'));
  assert.ok(ids.includes('drafts_waiting'));
  assert.ok(ids.includes('no_new_prospects'));
  assert.ok(ids.some((i) => i.startsWith('incident_')));
  // healthy funnel → no business-stall alerts
  assert.strictEqual(O.deriveAlerts({ awaiting_scoring: 2, drafts_to_review: 1, new_this_week: 12 }, []).length, 0);
});

test('deriveNextActions — links to real Pipeline queue keys', () => {
  const actions = O.deriveNextActions(
    { drafts_to_review: 5, awaiting_autonomous_gate: 8, replies: 3, high_score: 2, no_contact: 4, fb_only: 1, followup_recovery_deferred: 12 },
    { status: 'recommended', vertical: 'tree service' },
    [],
  );
  const byId = Object.fromEntries(actions.map((a) => [a.id, a]));
  assert.strictEqual(byId.approve_drafts.link, '/admin/pipeline?view=drafts-to-review');
  assert.strictEqual(byId.evaluate_autonomous_drafts.link, '/admin/pipeline?view=autonomous-drafts');
  assert.strictEqual(byId.evaluate_autonomous_drafts.count, 8);
  assert.strictEqual(byId.check_replies.link, '/admin/pipeline?view=replied');
  assert.strictEqual(byId.review_high_score.link, '/admin/pipeline?view=high-score');
  assert.strictEqual(byId.review_no_contact.link, '/admin/pipeline?view=no-reachable-contact');
  assert.strictEqual(byId.recover_sequence_continuity.link, '/admin/drip-campaign');
  assert.strictEqual(byId.recover_sequence_continuity.count, 12);
  assert.ok(byId.approve_focus); // recommended focus surfaces an approval action
});

test('zero current sequences with contacted prospects is an urgent continuity gap', () => {
  const alerts = O.deriveAlerts({
    awaiting_scoring: 0, drafts_to_review: 0, new_this_week: 1,
    contacted: 599, active_sequences: 0,
  }, []);
  const gap = alerts.find(row => row.id === 'sequence_continuity_gap');
  assert.ok(gap);
  assert.equal(gap.severity, 'urgent');
  assert.match(gap.detail, /599 contacted prospects/);
});

test('relationship counts exclude synthetic and quarantined intake', async () => {
  const db = makeDb((ops) => {
    if (ops.table !== 'leads') return [];
    return [
      { id: 'real', email: 'owner@acmeplumbing.com', lead_source: 'apollo', metadata: {} },
      { id: 'fixture', email: 'fixture@acmeplumbing.com', lead_source: 'apollo', metadata: { synthetic: true } },
      { id: 'quarantine', email: 'form@acmeplumbing.com', lead_source: 'website', metadata: { intake_safety: { contact_allowed: false } } },
    ];
  });
  assert.strictEqual(await O.countAuthenticLeadState(db, 'T1', 'replied'), 1);
});

test('full-inventory funnel uses the exact Pipeline contact-bucket definitions', () => {
  const rows = [
    { id: 'fb-lifecycle', status: 'new_lead', lifecycle_stage: 'fb_only', enrichment_status: 'enriched' },
    { id: 'fb-enrichment', status: 'new_lead', lifecycle_stage: 'enriched', enrichment_status: 'enriched_fb_only' },
    { id: 'phone', status: 'new_lead', lifecycle_stage: 'enriched', enrichment_status: 'enriched_phone_only' },
    { id: 'dead', status: 'new_lead', lifecycle_stage: 'enriched', enrichment_status: 'enriched_no_contact' },
    { id: 'email', status: 'new_lead', lead_source: 'prospecting_agent', lifecycle_stage: 'enriched', email: 'lead@smallco.com' },
    { id: 'manual', status: 'new_lead', lead_source: 'manual', lifecycle_stage: 'enriched', email: 'manual@smallco.com' },
    { id: 'contacted-regressed', status: 'contacted', lead_source: 'prospecting_agent', lifecycle_stage: 'enriched', email: 'sent@smallco.com' },
    { id: 'fixture', status: 'new_lead', lifecycle_stage: 'fb_only', metadata: { synthetic: true } },
  ];
  const funnel = O.computeLeadFunnel(rows, Date.parse('2026-09-11T12:00:00Z'));
  assert.strictEqual(funnel.fb_only, 2);
  assert.strictEqual(funnel.phone_only, 1);
  assert.strictEqual(funnel.no_contact, 1);
  assert.strictEqual(funnel.email_ready, 1);
  assert.strictEqual(funnel.enriched, 5, 'historical contacted rows are not current enriched stock');
  assert.strictEqual(funnel.awaiting_scoring, 1);
});

test('buildSnapshot — assembles funnel + actions + alerts, no throw', async () => {
  const counts = { leads: 0, drip_enrollments: 0, outreach_enrollments: 0, outreach_sequences: 0, drip_sends: 0, drip_inbound: 0, ops_incidents: 0 };
  // Return a count for head:true count queries; arrays for list queries.
  const db = makeDb((ops) => {
    if (ops.table === 'ops_incidents') return [];
    return typeof counts[ops.table] === 'number' ? counts[ops.table] : 0;
  });
  const tenant = { id: FGA_TENANT_ID, config: { prospecting_active_industries: '["hvac"]', target_states: '["FL"]' } };
  const snap = await O.buildSnapshot(db, tenant);
  assert.ok(snap.funnel && typeof snap.funnel.new_this_week === 'number');
  assert.ok(Array.isArray(snap.next_actions));
  assert.ok(!snap.next_actions.some((action) => action.id === 'approve_focus'),
    'the standing wide-industry plan is not an owner approval');
  assert.ok(Array.isArray(snap.alerts));
  assert.strictEqual(snap.focus.vertical, 'hvac');
});

test('buildSnapshot propagates current scoring stock into the persisted alert contract', async () => {
  const leads = Array.from({ length: 40 }, (_, i) => ({
    id: `lead-${i}`,
    status: 'new_lead',
    lead_source: 'prospecting_agent',
    lifecycle_stage: 'enriched',
    enrichment_status: 'enriched',
    email: `lead-${i}@smallco.com`,
    created_at: '2026-09-11T12:00:00.000Z',
    updated_at: '2026-09-11T12:00:00.000Z',
  }));
  const db = makeDb((ops) => {
    if (ops.table === 'leads') return leads;
    if (['ops_incidents', 'outreach_sequences', 'autosend_decisions'].includes(ops.table)) return [];
    return 0;
  });
  const snap = await O.buildSnapshot(db, { id: FGA_TENANT_ID, config: {} });

  assert.equal(snap.funnel.awaiting_scoring, 40);
  assert.equal(snap.stage_counts.awaiting_scoring, 40);
  assert.ok(snap.alerts.some((alert) => alert.id === 'enrichment_backlog'));
});
