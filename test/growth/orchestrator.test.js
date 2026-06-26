'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { makeDb } = require('./_stub');
const O = require('../../core/growth/orchestrator');

test('currentWeekStart — YYYY-MM-DD Monday', () => {
  assert.match(O.currentWeekStart(), /^\d{4}-\d{2}-\d{2}$/);
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
    { enriched: 40, drafts_to_review: 20, new_this_week: 0 },
    [{ agent_name: 'enrichment', issue_type: 'consecutive_failures', severity: 'red', business_impact: 'stalled' }],
  );
  const ids = alerts.map((a) => a.id);
  assert.ok(ids.includes('enrichment_backlog'));
  assert.ok(ids.includes('drafts_waiting'));
  assert.ok(ids.includes('no_new_prospects'));
  assert.ok(ids.some((i) => i.startsWith('incident_')));
  // healthy funnel → no business-stall alerts
  assert.strictEqual(O.deriveAlerts({ enriched: 2, drafts_to_review: 1, new_this_week: 12 }, []).length, 0);
});

test('deriveNextActions — links to real Pipeline queue keys', () => {
  const actions = O.deriveNextActions(
    { drafts_to_review: 5, replies: 3, high_score: 2, no_contact: 4, fb_only: 1 },
    { status: 'recommended', vertical: 'tree service' },
    [],
  );
  const byId = Object.fromEntries(actions.map((a) => [a.id, a]));
  assert.strictEqual(byId.approve_drafts.link, '/admin/pipeline?view=drafts-to-review');
  assert.strictEqual(byId.check_replies.link, '/admin/pipeline?view=replied');
  assert.strictEqual(byId.review_high_score.link, '/admin/pipeline?view=high-score');
  assert.strictEqual(byId.review_no_contact.link, '/admin/pipeline?view=no-reachable-contact');
  assert.ok(byId.approve_focus); // recommended focus surfaces an approval action
});

test('buildSnapshot — assembles funnel + actions + alerts, no throw', async () => {
  const counts = { leads: 0, drip_enrollments: 0, outreach_enrollments: 0, outreach_sequences: 0, drip_sends: 0, drip_inbound: 0, ops_incidents: 0 };
  // Return a count for head:true count queries; arrays for list queries.
  const db = makeDb((ops) => {
    if (ops.table === 'ops_incidents') return [];
    return typeof counts[ops.table] === 'number' ? counts[ops.table] : 0;
  });
  const tenant = { id: 'T1', config: { prospecting_active_industries: '["hvac"]', target_states: '["FL"]' } };
  const snap = await O.buildSnapshot(db, tenant);
  assert.ok(snap.funnel && typeof snap.funnel.new_this_week === 'number');
  assert.ok(Array.isArray(snap.next_actions));
  assert.ok(Array.isArray(snap.alerts));
  assert.strictEqual(snap.focus.vertical, 'hvac');
});
