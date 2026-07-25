/**
 * Production payload fixtures for the outcome classifier (2026-07-24).
 *
 * Every payload here was read VERBATIM from production `agent_jobs.result`
 * during the implementation pass. The first version of the classifier called
 * 10 healthy agents DOWN — including financial-dashboard, which had just
 * produced a correct dashboard. Fixtures exist so classifier changes are
 * measured against reality instead of intuition.
 *
 * If a new agent shape appears in production, add it here with its expected
 * verdict. A DOWN verdict on a working agent is worse than no verdict: it
 * trains the owner to ignore alerts.
 */

const test = require('node:test');
const assert = require('node:assert');
const { classifyRun, VERDICTS } = require('../core/autonomous-os/output-expectations');

const P = VERDICTS.PRODUCTIVE;
const I = VERDICTS.IDLE_CORRECT;
const S = VERDICTS.SKIPPED_FOR_CAUSE;
const F = VERDICTS.FAILED_TO_ACT;
const U = VERDICTS.UNVERIFIABLE;
const E = VERDICTS.ERROR;

const FIXTURES = [
  // ── genuinely productive ──
  ['financial-dashboard', P, { success: true, dashboard: { year: 2026, profit: { net: -1842.91 }, revenue: { total: 999 } } }],
  ['prospecting-orchestrator', P, { alerts: 2, success: true, coordination: { cleared: 0, updated: 10, examined: 683, superseded: 0 }, next_actions: 7, drafts_to_review: 95, snapshot_written: true }],
  ['churn-risk-detector', P, { score: 0, reasons: [], signals: { lead_trend: { prior: 55, recent: 469 } } }],
  ['platform-daily-digest', P, { success: true, sms_sent: 0, new_leads: 11, jobs_total: 386, email_result: { id: 'x', status: 'sent' } }],
  ['mercury-sync', P, { success: true, cash_balance: 1572.44, transactions_imported: 0, transactions_skipped_dup: 1 }],
  ['reporting', P, { type: 'weekly', period: { start: '2026-07-17' }, report: 'First Gen Automate — Weekly Report...' }],
  ['content-generation', P, { draft_id: 'a9f06f3f', slides: 5, images: 5, duration_ms: 50215 }],
  ['content-plan', P, { plan_id: '123b6efb', concepts: 2, week_start: '2026-07-20' }],
  ['commercial-discovery', P, { mode: 'daily_monitor', moved: 0, closed: 39, refreshed: 123 }],
  ['clients-manager', P, { total: 10, success: true, by_status: { new_lead: 7 }, hot_leads: [], stale_marked: 4 }],
  ['facebook-prospecting', P, { day0: { mode: 'day0', sent_sms: 0, candidates: 4, drafted_fb: 3, skipped_idempotent: 1 }, day7: { mode: 'day7', reason: 'cold_sms_disabled', skipped: true } }],
  ['monthly-usage-reset', P, { success: true, tenants_reset: 4 }],
  ['voice-receptionist', P, { success: true, emergency: false, classification: 'other', voice_call_sid: '0954091f' }],
  ['inbound-sms-responder', P, { reply: 'Sure! Patrick is the best person to talk to...', success: true, captured_lead_id: null }],
  ['client-health', P, { at_risk: [{ name: 'Apex Plumbing', score: 55 }], success: true, tenants: [{ name: 'Apex' }] }],
  ['account-management', P, { success: true, accounts: [{ name: '923A Coins', tier: 'scale' }] }],
  ['audit-dry-run', P, { year: 2026, success: true, breakdown: { missing_receipts: 67, late_period_closes: 88 } }],
  ['enrichment', P, { failed: 0, success: true, qualified: 1, processed: [{ reason: 'email_found', qualified: true }] }],
  ['system-monitor', P, { down: [], checked: 8, success: true, degraded: [] }],
  ['scoring', P, { scored: 9, success: true }],
  ['approval-queue', P, { pending: 2, success: true, push_sent: 1, email_sent: false }],
  ['drip-campaign', P, { task: 'sync_replies', matched: 0, results: [], success: true, processed: 18 }],
  ['supervised-executive-foundation', P, { period: '2026-07-23', revenue: { leads_created: 10 }, reliability: { jobs: 180 }, success: true }],

  // ── correctly idle: proved it looked ──
  ['scheduled-email-dispatch', I, { sent: 0, message: 'No emails due', success: true }],
  ['speed-to-lead', I, { swept: true, success: true, enqueued: 0, candidates: 0 }],
  ['notifications', I, { sent: 0, message: 'No pending notifications', success: true }],
  ['notification-push', I, { sent: 0, message: 'No pending push notifications', success: true }],
  ['reply-classification', I, { message: 'No unclassified replies', success: true, classified: 0 }],
  ['meeting-prep', I, { message: 'No meetings to prep', success: true, briefings: 0 }],
  ['threshold-alerts', I, { alerts: [], success: true }],
  ['nexus-monitor', I, { alerted: 0, success: true, summary: [], suppressed: 0 }],
  // Productive, not idle: it returns computed month figures, so it shows its
  // work product — same standard applied to churn-risk-detector. The
  // productive/idle_correct line is cosmetic for health purposes; what matters
  // is that neither is mistaken for a defect.
  ['bookkeeping', P, { issues: [], success: true, duplicates: [], queue_sync: { created: 0, resolved: 0 }, current_month: { net: 0, income_count: 0, expense_count: 0 } }],
  ['follow-up', I, { sent: 0, errors: [], skipped: 2, success: true, processed: [{ action: 'opted_out' }, { action: 'opted_out' }] }],
  ['partner-outreach', I, { sent: 0, errors: [], skipped: 5, success: true, processed: [{ action: 'nothing_due' }] }],
  ['review-request', I, { sent: 0, errors: [], skipped: 2, success: true, processed: [{ action: 'already_requested' }] }],
  ['referral-request', I, { sent: 0, errors: [], skipped: 1, success: true, processed: [{ action: 'already_requested' }] }],
  ['sales-nurture', I, { results: [{ handler: 'demo_followup', sent: 0, skipped: 0 }, { handler: 'nurture_outreach', sent: 0, skipped: 4 }] }],
  ['outreach-all-skipped', I, { errors: [], success: true, processed: [{ action: 'skipped_no_channel' }, { action: 'duplicate' }] }],
  // Unannotated entries = drafts actually created. 215 of these in 30d were
  // read as zero work by the first classifier, flagging a healthy agent DOWN.
  ['outreach-drafted', P, { errors: [], success: true, processed: [
    { company: 'Junk Bee Gone, LLC', lead_id: '467c5d00', channels: ['email'], sequence_ids: ['1f466dfd'] },
    { action: 'skipped_no_channel' }] }],

  // ── decisions, not idleness ──
  ['auto-outreach', S, { reason: 'deliverability_paused', skipped: true, success: true }],
  ['digest', S, { skipped: 'platform_tenant', tenant_id: '30566ed6' }],

  // ── REAL DEFECTS: these must stay flagged ──
  ['publisher', F, { total: 2, published: 0, duration_ms: 991 }],
  ['past-customer-reengagement', U, { sent: 0, skipped: 0, success: true }],
  ['image-generation', E, { error: 'No draftId provided' }],
];

test('every production payload classifies as expected', () => {
  const wrong = [];
  for (const [agent, expected, result] of FIXTURES) {
    const got = classifyRun({ result }).verdict;
    if (got !== expected) wrong.push(`${agent}: expected ${expected}, got ${got}`);
  }
  assert.deepStrictEqual(wrong, [],
    `classifier disagrees with production reality:\n  ${wrong.join('\n  ')}`);
});

test('the three real defects are the ONLY non-benign verdicts', () => {
  const bad = FIXTURES
    .filter(([, , result]) => {
      const v = classifyRun({ result }).verdict;
      return v === VERDICTS.UNVERIFIABLE || v === VERDICTS.FAILED_TO_ACT || v === VERDICTS.ERROR;
    })
    .map(([agent]) => agent)
    .sort();
  assert.deepStrictEqual(bad, ['image-generation', 'past-customer-reengagement', 'publisher'],
    'a false DOWN on a working agent trains the owner to ignore alerts');
});

test('fixture coverage is broad enough to be meaningful', () => {
  assert.ok(FIXTURES.length >= 40,
    `expected 40+ real payloads, have ${FIXTURES.length}`);
  const verdicts = new Set(FIXTURES.map(([, v]) => v));
  for (const v of [P, I, S, F, U, E]) {
    assert.ok(verdicts.has(v), `fixtures must exercise the ${v} verdict`);
  }
});
