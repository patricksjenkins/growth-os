/**
 * Deliverability breaker — the rule that cost two business days (2026-07-24).
 *
 * The old rule was `sent7d >= 20 && rate >= 4%`. At a 4% threshold a single
 * bounce trips any window of 25 or fewer sends, so the 20-send "minimum
 * sample" could never do the job it existed for. 1 bounce / 24 sends = 4.17%
 * paused the department, every later run logged a clean skip, and nobody was
 * told.
 *
 * These tests pin BOTH directions: one stale address must not stop the
 * business, and a genuinely bad list must still be stopped.
 */

const test = require('node:test');
const assert = require('node:assert');
const {
  DEFAULTS, classifyBounce, evaluateDeliverability, explain,
} = require('../core/revenue/deliverability-breaker');

const bounce = (recipient, payload = {}) => ({ recipient, event: 'bounced', payload });
const hardBounces = (n) => Array.from({ length: n }, (_, i) =>
  bounce(`dead${i}@example.com`, { bounce_type: 'hard' }));

/* ── The exact production incident ── */

test('THE INCIDENT: 1 bounce / 24 sends must NOT pause', () => {
  const r = evaluateDeliverability({
    sent7d: 24,
    bounceEvents: [bounce('sales@anytiimehandymanservices.com', { type: 'email.bounced' })],
    complaints7d: 0,
  });
  assert.strictEqual(r.paused, false,
    'one stale address in a 24-send window must not stop the sales department');
  assert.strictEqual(r.hardBounces, 1);
  assert.deepStrictEqual(r.suppressCandidates, ['sales@anytiimehandymanservices.com'],
    'the bad address must be handed back for suppression, not ignored');
  assert.match(r.detail, /suppress and continue/);
});

test('the old rule would have paused — proving the fix changes the outcome', () => {
  const sent7d = 24, bounces = 1;
  const oldRate = (bounces / sent7d) * 100;
  const oldWouldPause = sent7d >= 20 && oldRate >= 4;
  assert.strictEqual(oldWouldPause, true, 'old rule paused on this input');
  const now = evaluateDeliverability({ sent7d, bounceEvents: hardBounces(1), complaints7d: 0 });
  assert.strictEqual(now.paused, false, 'new rule does not');
});

test('one bounce never pauses at ANY volume below the sustained floor', () => {
  for (const sent of [1, 5, 10, 20, 24, 25, 30, 49]) {
    const r = evaluateDeliverability({ sent7d: sent, bounceEvents: hardBounces(1), complaints7d: 0 });
    assert.strictEqual(r.paused, false, `1 bounce / ${sent} sends must not pause`);
  }
});

/* ── Real deliverability risk must still stop sending ── */

test('a genuine bounce spike still pauses (sustained)', () => {
  // 6 hard bounces over 60 sends = 10%
  const r = evaluateDeliverability({ sent7d: 60, bounceEvents: hardBounces(6), complaints7d: 0 });
  assert.strictEqual(r.paused, true);
  assert.strictEqual(r.reason, 'sustained_bounce_rate');
});

test('a catastrophic rate pauses early, before statistical significance', () => {
  // 5 of 15 = 33% — must not wait for 50 sends
  const r = evaluateDeliverability({ sent7d: 15, bounceEvents: hardBounces(5), complaints7d: 0 });
  assert.strictEqual(r.paused, true);
  assert.strictEqual(r.reason, 'catastrophic_bounce_rate');
});

test('absolute hard-bounce count pauses even at a flattering rate', () => {
  // 12 bounces over 1000 sends = 1.2% — rate looks fine, volume does not
  const r = evaluateDeliverability({ sent7d: 1000, bounceEvents: hardBounces(12), complaints7d: 0 });
  assert.strictEqual(r.paused, true);
  assert.strictEqual(r.reason, 'absolute_hard_bounces');
});

test('complaints pause immediately at any volume', () => {
  const r = evaluateDeliverability({ sent7d: 3, bounceEvents: [], complaints7d: 2 });
  assert.strictEqual(r.paused, true);
  assert.strictEqual(r.reason, 'complaints');
  assert.match(r.detail, /at any volume/);
});

test('a single complaint does not pause — two do', () => {
  assert.strictEqual(evaluateDeliverability({ sent7d: 100, complaints7d: 1 }).paused, false);
  assert.strictEqual(evaluateDeliverability({ sent7d: 100, complaints7d: 2 }).paused, true);
});

/* ── Hard vs soft ── */

test('soft bounces never trip the breaker alone', () => {
  const soft = Array.from({ length: 8 }, (_, i) =>
    bounce(`full${i}@example.com`, { bounce_type: 'soft', reason: 'mailbox full' }));
  const r = evaluateDeliverability({ sent7d: 60, bounceEvents: soft, complaints7d: 0 });
  assert.strictEqual(r.paused, false, 'full mailboxes are not bad addresses');
  assert.strictEqual(r.softBounces, 8);
  assert.strictEqual(r.hardBounces, 0);
  assert.deepStrictEqual(r.suppressCandidates, [], 'soft bounces must not be suppressed');
});

test('bounce classification covers real provider vocabularies', () => {
  assert.strictEqual(classifyBounce({ payload: { bounce_type: 'Permanent' } }), 'hard');
  assert.strictEqual(classifyBounce({ payload: { reason: 'user unknown' } }), 'hard');
  assert.strictEqual(classifyBounce({ payload: { type: 'Transient' } }), 'soft');
  assert.strictEqual(classifyBounce({ payload: { diagnostic_code: 'mailbox full' } }), 'soft');
  assert.strictEqual(classifyBounce({ payload: { reason: 'greylisted, try later' } }), 'soft');
  assert.strictEqual(classifyBounce({ payload: {} }), 'hard',
    'unknown classification is treated as hard — the conservative choice');
});

test('a mixed window counts only hard bounces toward the rate', () => {
  const events = [...hardBounces(2),
    bounce('a@x.com', { bounce_type: 'soft' }), bounce('b@x.com', { bounce_type: 'soft' })];
  const r = evaluateDeliverability({ sent7d: 60, bounceEvents: events, complaints7d: 0 });
  assert.strictEqual(r.hardBounces, 2);
  assert.strictEqual(r.softBounces, 2);
  assert.strictEqual(r.bounceRatePct, Number(((2 / 60) * 100).toFixed(2)));
  assert.strictEqual(r.paused, false, '2 hard bounces is below the 3-bounce sustained floor');
});

/* ── Boundaries ── */

test('sustained rule requires ALL THREE conditions together', () => {
  const base = { complaints7d: 0 };
  // rate high + enough sends, but only 2 hard bounces
  assert.strictEqual(evaluateDeliverability({ ...base, sent7d: 50, bounceEvents: hardBounces(2) }).paused,
    false, '2 bounces is below the hard-bounce floor');
  // enough bounces + rate, but under the send floor -> caught by catastrophic only if extreme
  assert.strictEqual(evaluateDeliverability({ ...base, sent7d: 49, bounceEvents: hardBounces(3) }).paused,
    false, '3 bounces / 49 sends = 6.1% is under the 50-send floor and under 25%');
  // All three met, but only MARGINALLY over the limit (6% vs 4%). As of
  // 2026-07-29 this throttles instead of stopping: pausing to zero freezes the
  // denominator, so the rate cannot recover until bounces age out — which cost
  // three days on the company's only prospecting channel. It still refuses to
  // send at full volume, and every send must pass an MX check.
  const marginal = evaluateDeliverability({ ...base, sent7d: 50, bounceEvents: hardBounces(3) });
  assert.strictEqual(marginal.mode, 'throttle', '6% is over the limit but recoverable by sending clean');
  assert.strictEqual(marginal.paused, false);
  // At twice the limit it is a bad list, and it still stops dead.
  assert.strictEqual(evaluateDeliverability({ ...base, sent7d: 60, bounceEvents: hardBounces(6) }).paused,
    true, '10% is too high to send through at any volume');
});

test('zero sends never pauses (no data is not bad data)', () => {
  const r = evaluateDeliverability({ sent7d: 0, bounceEvents: [], complaints7d: 0 });
  assert.strictEqual(r.paused, false);
  assert.strictEqual(r.bounceRatePct, 0);
});

test('thresholds are configurable without editing the rule', () => {
  const strict = evaluateDeliverability(
    { sent7d: 24, bounceEvents: hardBounces(1), complaints7d: 0 },
    { sustainedMinHardBounces: 1, sustainedMinSends: 20, sustainedRatePct: 4 });
  // 4.17% — over the overridden limit, under the 8% stop ceiling, so throttled.
  assert.strictEqual(strict.mode, 'throttle', 'overrides must be honoured');
  assert.strictEqual(strict.reason, 'sustained_bounce_rate');
  // Overriding the ceiling too must produce a full stop.
  const hardStop = evaluateDeliverability(
    { sent7d: 24, bounceEvents: hardBounces(1), complaints7d: 0 },
    { sustainedMinHardBounces: 1, sustainedMinSends: 20, sustainedRatePct: 4, throttleMaxRatePct: 4 });
  assert.strictEqual(hardStop.paused, true, 'the stop ceiling is configurable too');
});

test('explain() states the decision in owner language', () => {
  const paused = evaluateDeliverability({ sent7d: 60, bounceEvents: hardBounces(6) });
  assert.match(explain(paused), /^Sending PAUSED \(sustained_bounce_rate\)/);
  // A marginal rate reads as THROTTLED, and says how to get out of it.
  const throttled = evaluateDeliverability({ sent7d: 71, bounceEvents: hardBounces(3) });
  assert.match(explain(throttled), /^Sending THROTTLED \(sustained_bounce_rate\)/);
  assert.match(explain(throttled), /more clean send/);
  const ok = evaluateDeliverability({ sent7d: 24, bounceEvents: hardBounces(1) });
  assert.match(explain(ok), /^Sending allowed/);
});

test('defaults are the documented values', () => {
  assert.strictEqual(DEFAULTS.sustainedMinSends, 50,
    'must exceed 25, or one bounce can trip a 4% threshold again');
  assert.ok(DEFAULTS.sustainedMinSends > (100 / DEFAULTS.sustainedRatePct),
    'minimum sample must make a single bounce mathematically unable to trip the rate');
});
