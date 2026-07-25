/**
 * The acceptance test for the whole outcome-contract layer (2026-07-24).
 *
 * Blueprint v3 named a single falsifiable test for whether the control plane
 * is real or cosmetic:
 *
 *   "If the outcome contracts classify the 1,775 zero-work dispatch sweeps as
 *    correctly idle AND flag past-customer-reengagement as wrongly idle, the
 *    layer works. If they can't tell those apart, it's cosmetic."
 *
 * Every payload below is a VERBATIM shape read from production agent_jobs on
 * 2026-07-24, so this is that test, executable.
 */

const test = require('node:test');
const assert = require('node:assert');
const {
  VERDICTS, classifyRun, classifyAgentHistory, countWork, eligibilityEvidence,
  verdictToOutcomeStates,
} = require('../core/autonomous-os/output-expectations');

/* ── The two canonical cases the entire layer exists to separate ── */

test('CANONICAL A: scheduled-email-dispatch empty sweep is CORRECTLY idle', () => {
  // 1,775 of 1,775 runs in 30 days looked like this.
  const r = classifyRun({ result: { sent: 0, message: 'No emails due', success: true } });
  assert.strictEqual(r.verdict, VERDICTS.IDLE_CORRECT,
    'an empty queue that says so is not a defect');
  assert.strictEqual(verdictToOutcomeStates(r.verdict).business_outcome_state, 'not_applicable');
});

test('CANONICAL B: past-customer-reengagement is WRONGLY idle', () => {
  // 12 of 12 runs, all-time: sent 0, skipped 0 — it evaluated nothing at all.
  const r = classifyRun({ result: { sent: 0, skipped: 0, success: true } });
  assert.strictEqual(r.verdict, VERDICTS.UNVERIFIABLE,
    'zero output with zero evidence of looking must not pass as idle');
  assert.match(r.why, /no evidence/);
});

test('CANONICAL A vs B: the layer separates them — the falsifiable claim', () => {
  const dispatch = classifyRun({ result: { sent: 0, message: 'No emails due', success: true } });
  const reengage = classifyRun({ result: { sent: 0, skipped: 0, success: true } });
  assert.notStrictEqual(dispatch.verdict, reengage.verdict,
    'if these two collapse to the same verdict the control plane is cosmetic');
  assert.strictEqual(dispatch.verdict, VERDICTS.IDLE_CORRECT);
  assert.strictEqual(reengage.verdict, VERDICTS.UNVERIFIABLE);
});

test('a repeat offender becomes DOWN, a repeat empty sweeper does not', () => {
  const reengageRuns = Array.from({ length: 12 },
    () => ({ result: { sent: 0, skipped: 0, success: true } }));
  const down = classifyAgentHistory(reengageRuns);
  assert.strictEqual(down.health, 'down',
    'past-customer-reengagement must be DOWN, not "100% completed"');
  assert.ok(down.consecutive_bad >= 3);

  const dispatchRuns = Array.from({ length: 60 },
    () => ({ result: { sent: 0, message: 'No emails due', success: true } }));
  const ok = classifyAgentHistory(dispatchRuns);
  assert.strictEqual(ok.health, 'idle_ok',
    'a legitimately empty queue must never be called DOWN');
  assert.strictEqual(ok.consecutive_bad, 0);
});

/* ── Real production payloads, one per agent ── */

test('publisher {total:2, published:0} is FAILED_TO_ACT, not idle', () => {
  // G08 confirmed: work was available and none shipped. This is the case a
  // naive "zero output" check would wrongly forgive as idle.
  const r = classifyRun({ result: { total: 2, published: 0, duration_ms: 991 } });
  assert.strictEqual(r.verdict, VERDICTS.FAILED_TO_ACT);
  assert.strictEqual(verdictToOutcomeStates(r.verdict).business_outcome_state, 'not_achieved');
});

test('speed-to-lead {candidates:0} is correctly idle — best-in-class signal', () => {
  const r = classifyRun({ result: { swept: true, success: true, enqueued: 0, candidates: 0 } });
  assert.strictEqual(r.verdict, VERDICTS.IDLE_CORRECT);
  assert.match(r.why, /0 candidates/);
});

test('declines for cause are correct idleness, not failure', () => {
  // follow-up, review-request, referral-request, partner-outreach all do this.
  const followUp = classifyRun({ result: { sent: 0, skipped: 2, success: true,
    processed: [{ action: 'opted_out' }, { action: 'opted_out' }] } });
  assert.strictEqual(followUp.verdict, VERDICTS.IDLE_CORRECT);

  const partner = classifyRun({ result: { sent: 0, skipped: 5, success: true,
    processed: [{ action: 'nothing_due' }] } });
  assert.strictEqual(partner.verdict, VERDICTS.IDLE_CORRECT);

  const review = classifyRun({ result: { sent: 0, skipped: 1, success: true,
    processed: [{ action: 'already_requested' }] } });
  assert.strictEqual(review.verdict, VERDICTS.IDLE_CORRECT);
});

test('auto-outreach deliverability pause is a decision, not idleness', () => {
  const r = classifyRun({ result: { skipped: true, success: true,
    reason: 'deliverability_paused' } });
  assert.strictEqual(r.verdict, VERDICTS.SKIPPED_FOR_CAUSE);
  assert.match(r.why, /deliverability_paused/);
});

test('productive runs are recognised across shapes', () => {
  assert.strictEqual(classifyRun({ result: { sent: 21, success: true } }).verdict, VERDICTS.PRODUCTIVE);
  assert.strictEqual(classifyRun({ result: { task: 'sync_replies', matched: 0, processed: 18, success: true } }).verdict,
    VERDICTS.PRODUCTIVE, 'drip processed:18 is work');
  assert.strictEqual(classifyRun({ result: { checked: 8, down: [], degraded: [], success: true } }).verdict,
    VERDICTS.PRODUCTIVE, 'system-monitor checking 8 dependencies is work');
  // sales-nurture nests counters per handler
  assert.strictEqual(classifyRun({ result: { results: [
    { handler: 'demo_followup', sent: 2, skipped: 0 },
    { handler: 'trial_checkin', sent: 0, skipped: 0 }] } }).verdict, VERDICTS.PRODUCTIVE);
});

test('sales-nurture with all-zero nested handlers is idle, not productive', () => {
  const r = classifyRun({ result: { results: [
    { handler: 'demo_followup', sent: 0, skipped: 0 },
    { handler: 'trial_checkin', sent: 0, skipped: 0 },
    { handler: 'nurture_outreach', sent: 0, skipped: 4 }] } });
  assert.notStrictEqual(r.verdict, VERDICTS.PRODUCTIVE);
  assert.strictEqual(r.verdict, VERDICTS.IDLE_CORRECT, '4 nested declines = looked and said no');
});

test('processed arrays of only skips do not count as work', () => {
  const r = classifyRun({ result: { errors: [], success: true, processed: [
    { action: 'skipped_no_channel' }, { action: 'duplicate' }] } });
  assert.strictEqual(countWork(r.result ?? { processed: [] }), 0);
  assert.notStrictEqual(r.verdict, VERDICTS.PRODUCTIVE);
});

test('failures are errors, never idleness', () => {
  assert.strictEqual(classifyRun({ status: 'failed', error: new Error('x') }).verdict, VERDICTS.ERROR);
  assert.strictEqual(classifyRun({ result: { success: false } }).verdict, VERDICTS.ERROR);
});

test('eligibility evidence requires the agent to have looked', () => {
  assert.strictEqual(eligibilityEvidence({ sent: 0, skipped: 0 }).proved, false,
    'sent:0/skipped:0 proves nothing');
  assert.strictEqual(eligibilityEvidence({ candidates: 0 }).proved, true);
  assert.strictEqual(eligibilityEvidence({ message: 'No emails due' }).emptyQueueSignal, true);
});
