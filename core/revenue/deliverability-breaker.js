'use strict';

/**
 * Deliverability circuit breaker — the corrected rule.
 *
 * WHY THIS EXISTS
 * On 2026-07-24 the outbound sales department stopped for two business days.
 * Cause: 1 bounce out of 24 sends = 4.17%, and the rule was
 *
 *     (sent7d >= 20 && bounceRate7d >= 4) || complaints7d >= N
 *
 * At a 4% threshold a SINGLE bounce trips the breaker for any window with
 * 25 or fewer sends (1/25 = 4%). The 20-send minimum sample was therefore
 * mathematically incapable of protecting against a one-off stale address —
 * the exact case it was meant to tolerate. Sending stopped, every later run
 * recorded a clean skip, and nobody was told.
 *
 * Two further defects found in the same code:
 *   - the bounce and complaint counts had NO tenant filter, so a client
 *     tenant's bounces could pause FGA's sending (cross-tenant bleed in the
 *     safety layer itself)
 *   - hard and soft bounces were treated identically, so a full mailbox or a
 *     transient greylist counted the same as a dead domain
 *
 * THE RULE
 * Deliberately NOT "raise the threshold". Four independent conditions, each
 * targeting a different real risk:
 *
 *   1. COMPLAINTS      >= 2 in 7d  → pause immediately at any volume.
 *      Spam complaints are the fastest way to lose a sending domain and are
 *      never a measurement artifact.
 *
 *   2. CATASTROPHIC    rate >= 25% with >= 12 sends → pause.
 *      A list this bad must stop before it reaches statistical significance.
 *
 *   3. SUSTAINED       >= 3 hard bounces AND >= 50 sends AND rate >= 4% → pause.
 *      The normal case. 50 sends means one bounce is 2% and cannot trip it;
 *      three hard bounces means the pattern is real, not one dead address.
 *
 *   4. ABSOLUTE        >= 10 hard bounces in 7d → pause regardless of rate.
 *      Failsafe for high volume where a bad segment hides behind a good rate.
 *
 * Soft bounces (mailbox full, greylisted, transient) are counted and
 * reported but never trip the breaker on their own.
 *
 * When the rule declines to pause on a small sample it returns
 * `suppressCandidates` — the bouncing addresses. The caller suppresses those
 * and keeps sending to everyone else. That is the correct response to one
 * stale address: remove it, replace it, continue.
 */

const DEFAULTS = Object.freeze({
  complaintPause7d: 2,
  catastrophicRatePct: 25,
  catastrophicMinSends: 12,
  sustainedMinHardBounces: 3,
  sustainedMinSends: 50,
  sustainedRatePct: 4,
  absoluteHardBounces: 10,
  // Recovery mode: how many verified sends a throttled day may still make.
  throttleDailyCap: 8,
  // Above this, the sustained condition STOPS rather than throttles. A rate
  // modestly over the limit on a small sample is probably a couple of stale
  // addresses; a rate at twice the limit is a bad list, and no amount of clean
  // volume makes sending through it safe.
  throttleMaxRatePct: 8,
});

// Provider bounce classifications that mean the address is permanently bad.
const HARD_BOUNCE_PATTERNS = [
  /hard/i, /permanent/i, /invalid/i, /not[_\s-]?found/i, /no[_\s-]?such/i,
  /unknown[_\s-]?user/i, /does[_\s-]?not[_\s-]?exist/i, /rejected/i, /suppress/i,
];
const SOFT_BOUNCE_PATTERNS = [
  /soft/i, /transient/i, /temporary/i, /mailbox[_\s-]?full/i, /quota/i,
  /greylist/i, /defer/i, /timeout/i, /throttl/i,
];

/**
 * Classify one bounce event. Providers disagree on field names, so check the
 * common ones. Unknown classification is treated as HARD — the conservative
 * choice for deliverability, since assuming a bad address is recoverable is
 * how a domain's reputation degrades quietly.
 */
function classifyBounce(event = {}) {
  const p = event.payload || {};
  const raw = [
    p.bounce_type, p.bounceType, p.type, p.sub_type, p.subType,
    p.reason, p.diagnostic_code, p.description, event.event,
  ].filter(Boolean).join(' ');
  if (SOFT_BOUNCE_PATTERNS.some((re) => re.test(raw))) return 'soft';
  if (HARD_BOUNCE_PATTERNS.some((re) => re.test(raw))) return 'hard';
  return 'hard';
}

/**
 * Decide whether sending should pause.
 *
 * Pure — no database, no clock. Callers supply counts already scoped to ONE
 * tenant; passing another tenant's events is the cross-tenant bug this
 * replaces.
 *
 * @param {{sent7d:number, bounceEvents:Array, complaints7d:number}} input
 * @param {object} [cfg] threshold overrides
 * @returns {{paused:boolean, reason:string|null, detail:string,
 *            hardBounces:number, softBounces:number, bounceRatePct:number,
 *            suppressCandidates:string[], evaluated:object}}
 */
function evaluateDeliverability({ sent7d = 0, bounceEvents = [], complaints7d = 0 } = {}, cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const hard = [];
  const soft = [];
  for (const e of bounceEvents) {
    (classifyBounce(e) === 'soft' ? soft : hard).push(e);
  }
  const hardBounces = hard.length;
  const softBounces = soft.length;
  // Rate is computed on HARD bounces: a full mailbox is not a bad address.
  const bounceRatePct = sent7d > 0 ? (hardBounces / sent7d) * 100 : 0;
  const suppressCandidates = [...new Set(hard.map((e) => e.recipient).filter(Boolean))];

  const evaluated = {
    sent7d,
    hardBounces,
    softBounces,
    complaints7d,
    bounceRatePct: Number(bounceRatePct.toFixed(2)),
    thresholds: c,
  };

  const decide = (reason, detail) => ({
    paused: true, mode: 'stop', reason, detail, hardBounces, softBounces,
    bounceRatePct: Number(bounceRatePct.toFixed(2)), suppressCandidates, evaluated,
  });

  /*
   * THROTTLE, NOT STOP.
   *
   * A rolling-window RATE breaker that stops sending to zero cannot recover:
   * the denominator freezes, so the rate stays exactly where it is until the
   * oldest bounce ages out. On 2026-07-28 that meant THREE DAYS dark on the
   * company's only prospecting channel — for 3 bounces out of 71 sends.
   *
   * "It will resume Friday" is not an acceptable answer when this is the only
   * channel. Continuing to send CLEAN mail is also the fastest way out: 8
   * verified sends drop 3/71 (4.2%) to 3/79 (3.8%), under the limit, in one
   * day instead of three.
   *
   * So the SUSTAINED condition — the ambiguous one, where a pattern might be
   * real — throttles to a small, MX-verified volume instead of stopping. The
   * unambiguous dangers (spam complaints, a catastrophic rate, a large
   * absolute count) still stop dead, because those are not measurement
   * artifacts and no amount of clean volume makes them safe.
   */
  const throttle = (reason, detail) => ({
    paused: false,
    mode: 'throttle',
    throttled: true,
    throttleDailyCap: c.throttleDailyCap,
    requireVerifiedDomain: true,
    reason,
    detail,
    hardBounces, softBounces,
    bounceRatePct: Number(bounceRatePct.toFixed(2)), suppressCandidates, evaluated,
  });

  if (complaints7d >= c.complaintPause7d) {
    return decide('complaints',
      `${complaints7d} spam complaints in 7d (limit ${c.complaintPause7d}) — pausing at any volume`);
  }
  if (sent7d >= c.catastrophicMinSends && bounceRatePct >= c.catastrophicRatePct) {
    return decide('catastrophic_bounce_rate',
      `${bounceRatePct.toFixed(1)}% hard-bounce rate over ${sent7d} sends (limit ${c.catastrophicRatePct}%)`);
  }
  if (hardBounces >= c.absoluteHardBounces) {
    return decide('absolute_hard_bounces',
      `${hardBounces} hard bounces in 7d (limit ${c.absoluteHardBounces}) regardless of rate`);
  }
  if (hardBounces >= c.sustainedMinHardBounces && sent7d >= c.sustainedMinSends &&
      bounceRatePct >= c.sustainedRatePct) {
    // Twice the limit or worse is a list problem, not a measurement artifact.
    if (bounceRatePct >= c.throttleMaxRatePct) {
      return decide('sustained_bounce_rate',
        `${hardBounces} hard bounces, ${bounceRatePct.toFixed(1)}% over ${sent7d} sends `
        + `— at or above ${c.throttleMaxRatePct}%, too high to send through safely`);
    }
    const need = Math.max(0, Math.ceil(hardBounces / (c.sustainedRatePct / 100)) - sent7d);
    return throttle('sustained_bounce_rate',
      `${hardBounces} hard bounces, ${bounceRatePct.toFixed(1)}% over ${sent7d} sends `
      + `(limit ${c.sustainedRatePct}%). THROTTLED to ${c.throttleDailyCap}/day, verified domains only — `
      + `about ${need} more clean send(s) brings the rate back under the limit`);
  }

  // Not paused. If there ARE bounces, the correct action is to suppress those
  // addresses and keep sending — not to stop the department.
  const detail = hardBounces > 0
    ? `ok: ${hardBounces} hard bounce(s) over ${sent7d} sends (${bounceRatePct.toFixed(1)}%) — below every pause condition; suppress and continue`
    : `ok: 0 hard bounces over ${sent7d} sends`;
  return {
    paused: false, mode: 'ok', reason: null, detail, hardBounces, softBounces,
    bounceRatePct: Number(bounceRatePct.toFixed(2)), suppressCandidates, evaluated,
  };
}

/** Human-readable explanation of why the breaker did or did not fire. */
function explain(result) {
  if (result.mode === 'throttle') return `Sending THROTTLED (${result.reason}) — ${result.detail}`;
  if (!result.paused) return `Sending allowed — ${result.detail}`;
  return `Sending PAUSED (${result.reason}) — ${result.detail}`;
}

module.exports = {
  DEFAULTS,
  classifyBounce,
  evaluateDeliverability,
  explain,
};
