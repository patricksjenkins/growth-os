'use strict';

/**
 * The draft -> send handoff, and the guardian's ability to act on it.
 *
 * PRODUCTION, 2026-07-26 16:44 ET (measured):
 *   - the corrected drafter created 25 gate-eligible drafts
 *   - the last sender had run at 16:35, before they existed
 *   - no further sender was queued; the next scheduled window was gone
 *   - the guardian classified the day `blocked_quality` from drafts scored
 *     EARLIER, and its remediation was 'regenerate_drafts' — more drafts
 *     nobody would send. After 17:00 the state became `missed_daily_outcome`,
 *     which had no remediation at all.
 * Every job reported success and the day closed at 0/25.
 *
 * These tests execute planRemediation() and the handoff branch directly.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { HEALTH } = require('../core/revenue/daily-outcome');

const guardian = require('../worker/agents/revenue-guardian');
const { planRemediation } = guardian;

const openCaps = { dailyRemaining: 25, deliverabilityPaused: false };
const trace = (sendReady, blockReasons = []) => ({
  inventory: { sendReady, scored: 500, withEmail: 300 },
  blockReasons,
});

test('send-ready drafts get the SENDER, not another round of drafting', () => {
  // The exact 16:44 state: drafts sitting ready, day scored blocked_quality
  // from earlier drafts.
  const plan = planRemediation(
    HEALTH.BLOCKED_QUALITY,
    trace(25, [{ reason: 'draft_quality', count: 8, class: 'quality' }]),
    openCaps,
  );
  assert.ok(plan.includes('run_sender'),
    'inventory that can go out today must be sent, not regenerated');
  assert.ok(!plan.includes('regenerate_drafts'),
    'making more drafts while 25 sit unsent is the loop that produced 0/25');
});

test('a missed daily outcome with send-ready drafts still runs the sender', () => {
  // After 17:00 this state had NO remediation, so the evening could never
  // recover even with a full queue of sendable drafts.
  const plan = planRemediation(HEALTH.MISSED_DAILY_OUTCOME, trace(25), openCaps);
  assert.ok(plan.includes('run_sender'), 'a miss with sendable inventory is still actionable');
});

test('a missed outcome with NOTHING send-ready replenishes instead of spinning', () => {
  const plan = planRemediation(HEALTH.MISSED_DAILY_OUTCOME, trace(0), openCaps);
  assert.deepStrictEqual(plan, ['replenish_inventory']);
  assert.ok(!plan.includes('run_sender'), 'never queue a sender with nothing to send');
});

test('lead qualification and draft quality get DIFFERENT remediations', () => {
  // score_threshold = the LEAD scored too low -> rescore/replenish.
  // draft_quality   = the WRITTEN EMAIL scored too low -> redraft.
  // Both were classed 'quality', so a scoring problem re-ran the drafter and
  // produced new emails for the same unqualified leads.
  const qualification = planRemediation(
    HEALTH.BLOCKED_QUALITY,
    trace(0, [{ reason: 'score_threshold', count: 9, class: 'quality' }]),
    openCaps,
  );
  assert.deepStrictEqual(qualification, ['rescore_leads', 'replenish_inventory'],
    'a lead-qualification block must not be answered by rewriting emails');

  const writing = planRemediation(
    HEALTH.BLOCKED_QUALITY,
    trace(0, [{ reason: 'draft_quality', count: 9, class: 'quality' }]),
    openCaps,
  );
  assert.deepStrictEqual(writing, ['regenerate_drafts']);
});

test('a hard block is never overridden by available inventory', () => {
  // Deliverability/config/provider blocks are real stops. Having drafts ready
  // must not smuggle a send past them.
  for (const health of [HEALTH.BLOCKED_DELIVERABILITY, HEALTH.BLOCKED_CONFIGURATION, HEALTH.BLOCKED_PROVIDER]) {
    const plan = planRemediation(health, trace(25), openCaps);
    assert.ok(!plan.includes('run_sender'), `${health} must not run the sender`);
  }
});

test('a paused breaker or exhausted cap stops the sender being queued', () => {
  assert.ok(!planRemediation(HEALTH.BEHIND_TARGET, trace(25),
    { dailyRemaining: 0, deliverabilityPaused: false }).includes('run_sender'),
  'the daily cap is a hard stop');
  assert.ok(!planRemediation(HEALTH.BEHIND_TARGET, trace(25),
    { dailyRemaining: 25, deliverabilityPaused: true }).includes('run_sender'),
  'a paused breaker is a hard stop');
});

test('every agent the guardian may queue is a real, registered agent', () => {
  // A remediation naming an agent that does not resolve is a silent no-op.
  const { REMEDIATION_TARGETS } = guardian;
  const names = new Set(Object.values(REMEDIATION_TARGETS).flat());
  for (const name of names) {
    assert.doesNotThrow(() => require(`../worker/agents/${name}`),
      `remediation target '${name}' is not a loadable agent`);
  }
  assert.ok(!names.has('revenue-guardian'), 'self-enqueue would be an uncontrolled loop');
});
