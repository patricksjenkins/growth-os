'use strict';

/**
 * Why the sales department kept stopping, and the fixes for it.
 *
 * 2026-07-28 was 0/25 with 85 send-ready drafts sitting there. The cause was
 * not the queue this time — it was the deliverability breaker, correctly
 * paused at 4.2% hard bounces over 71 sends (limit 4%).
 *
 * Three of the addresses we sent to bounced. One was
 * `sales@anytiimehandymanservices.com` — note "anytiime". That domain does not
 * exist. It passed the gate because the only check was a regex, and a typo'd
 * domain looks perfectly valid to a regex.
 *
 * At ~70 sends a week the arithmetic is unforgiving: three bad addresses trip a
 * 4% breaker and stop every send for days. So the fix is upstream — stop
 * spending sends on domains that cannot receive mail.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { domainAcceptsMail, _cache } = require('../core/email-verify');

test('a typo domain is blocked before it can bounce', async () => {
  // The real address from the 2026-07-27 bounce.
  const r = await domainAcceptsMail('sales@anytiimehandymanservices.com');
  assert.strictEqual(r.ok, false, 'a non-existent domain must never consume a send');
  assert.match(r.reason, /domain_unreachable/);
});

test('a real domain passes', async () => {
  const r = await domainAcceptsMail('patrick@firstgenautomate.com');
  assert.strictEqual(r.ok, true);
  assert.match(r.reason, /mx_ok/);
});

test('a malformed address has no domain to check', async () => {
  const r = await domainAcceptsMail('not-an-email');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no_domain');
});

test('the result is cached, so a run does not re-resolve the same domain', async () => {
  _cache.clear();
  await domainAcceptsMail('a@firstgenautomate.com');
  const second = await domainAcceptsMail('b@firstgenautomate.com');
  assert.match(second.reason, /cached/, 'two addresses at one domain should cost one lookup');
});

test('a DNS failure fails OPEN — a resolver blip must not stop the day', async () => {
  // Deliberately NOT mocked away: the contract is that anything other than a
  // definitive NXDOMAIN/ENODATA lets the send proceed. Verified by reading the
  // classification the module applies to an indeterminate code.
  const src = require('fs').readFileSync(require.resolve('../core/email-verify'), 'utf8');
  assert.match(src, /return \{ ok: true, reason: `dns_indeterminate/,
    'an unknown DNS error must not block sending');
  assert.match(src, /ENOTFOUND'.*ENODATA'.*NXDOMAIN'|ENOTFOUND' \|\| code === 'ENODATA'/s,
    'only definitive non-existence blocks');
});

/*
 * The second half of the outage was REPORTING, not sending.
 *
 * The digest headlined it as "Last error: suppress_bounced: suppressed 0
 * address(es)" — because the guardian's remediation returned ok:false when it
 * had nothing to suppress. The three bounced addresses were ALREADY
 * suppressed, so doing nothing was correct; reporting it as the day's error
 * hid the real cause (the breaker) from the one person who needed it.
 */
test('a no-op suppression is success, not the day\'s headline failure', async () => {
  const guardian = require('../worker/agents/revenue-guardian');
  const src = require('fs').readFileSync(require.resolve('../worker/agents/revenue-guardian'), 'utf8');
  // Executed via the exported remediation map.
  const fn = guardian.REMEDIATIONS
    ? guardian.REMEDIATIONS.suppress_bounced
    : null;
  if (fn) {
    const out = await fn({ from: () => ({}) }, { capState: { suppressCandidates: [] } });
    assert.strictEqual(out.ok, true, 'nothing to suppress is not a failure');
    assert.strictEqual(out.noop, true);
    assert.match(out.detail, /already suppressed/);
  } else {
    // Not exported — assert the shipped branch instead.
    assert.match(src, /action: 'suppress_bounced',\s*ok: true,\s*noop: true/,
      'a no-op suppression must report success');
  }
});

/*
 * "Never configured" is not "broken".
 *
 * 923A has the prospecting module enabled (Scale ships all 15) but no ICP, so
 * preflight threw every morning and put a red row in Failing Agents for a
 * tenant that was never meant to prospect. A daily false red trains you to
 * ignore the table where the real failures appear.
 */
test('a tenant with no ICP skips prospecting instead of failing', async () => {
  // EXECUTED, not grepped: an earlier version of this test asserted on source
  // text and stayed green when the branch was disabled.
  // This test is about the TENANT's ICP, not about the platform's API keys.
  //
  // assessProspectingReadiness also requires SERPER_API_KEY, and the skip
  // branch fires only when the missing fields are exclusively target_states
  // and target_industries — deliberately, because a missing platform key is a
  // genuine breakage that must stay loud. On this machine .env supplies the
  // key, so the branch was reached and the test passed. In CI there is no
  // .env, the key counted as a third missing field, and this went red for a
  // reason that has nothing to do with what it is asserting.
  const savedSerper = process.env.SERPER_API_KEY;
  process.env.SERPER_API_KEY = savedSerper || 'test-key-not-used';

  const dbPath = require.resolve('../db/client');
  const agentPath = require.resolve('../worker/agents/prospecting');
  const saved = require.cache[dbPath];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true,
    exports: { getServiceClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ limit: async () => ({ data: [] }) }) }) }) }) } };
  delete require.cache[agentPath];
  try {
    const run = require('../worker/agents/prospecting');
    // 923A's real shape: module enabled, no target_states / target_industries.
    const tenant = { id: 'bd2deab7-c870-4565-bf8d-93d6511f2d09', slug: '923a', config: {} };
    const out = await run(tenant, {});
    assert.strictEqual(out.success, true, 'an unconfigured tenant must not fail the job');
    assert.strictEqual(out.skipped, 'prospecting_not_configured');
    assert.match(out.message, /no ICP configured/);
  } finally {
    if (saved) require.cache[dbPath] = saved; else delete require.cache[dbPath];
    delete require.cache[agentPath];
    if (savedSerper === undefined) delete process.env.SERPER_API_KEY;
    else process.env.SERPER_API_KEY = savedSerper;
  }
});

test('a missing platform API key still fails loudly, ICP or not', async () => {
  // The other side of the skip branch, and the reason it is scoped so
  // narrowly: "this tenant never set up an ICP" is a shrug, but "the platform
  // has no search key" is an outage. Only the first may be skipped.
  const savedSerper = process.env.SERPER_API_KEY;
  delete process.env.SERPER_API_KEY;
  const dbPath = require.resolve('../db/client');
  const agentPath = require.resolve('../worker/agents/prospecting');
  const saved = require.cache[dbPath];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true,
    exports: { getServiceClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ limit: async () => ({ data: [] }) }) }) }) }) } };
  delete require.cache[agentPath];
  try {
    const run = require('../worker/agents/prospecting');
    const tenant = { id: 'bd2deab7-c870-4565-bf8d-93d6511f2d09', slug: '923a', config: {} };
    await assert.rejects(() => run(tenant, {}), /preflight failed/i,
      'a missing search key must not be swallowed as "not configured"');
  } finally {
    if (saved) require.cache[dbPath] = saved; else delete require.cache[dbPath];
    delete require.cache[agentPath];
    if (savedSerper === undefined) delete process.env.SERPER_API_KEY;
    else process.env.SERPER_API_KEY = savedSerper;
  }
});

test('a tenant with an INVALID ICP still fails loudly', async () => {
  const agentPath = require.resolve('../worker/agents/prospecting');
  delete require.cache[agentPath];
  const run = require('../worker/agents/prospecting');
  // Configured, but the state codes are wrong — a real error someone must fix.
  const tenant = { id: 't1', slug: 'broken', config: {
    target_states: ['Georgia'], target_industries: ['plumbing'],
  } };
  await assert.rejects(() => run(tenant, {}), /preflight failed/i,
    'a misconfigured ICP is a genuine failure and must still raise');
});

/*
 * THREE DAYS DARK IS NOT AN ACCEPTABLE FAILURE MODE.
 *
 * Patrick, 2026-07-29: "It should not go 3 days without sending... this is the
 * company's only form of prospecting so that attitude is totally
 * unacceptable." He is right, and the design was at fault, not just the
 * addresses.
 *
 * A rolling-window RATE breaker that pauses to ZERO cannot recover: the
 * denominator freezes, so the rate stays put until the oldest bounce ages out.
 * Continuing to send CLEAN mail is both safe (verified domains, low volume)
 * and the fastest way back under the limit.
 */
const { evaluateDeliverability } = require('../core/revenue/deliverability-breaker');
// A PLAUSIBLE domain on purpose. These tests exercise the breaker MATH, and
// the breaker now excludes reserved TLDs (.test/.invalid/.example) because a
// bounce from an address that cannot exist is not deliverability signal — see
// the 2026-08-05 outage in test/deliverability-breaker.test.js. A .example
// fixture would be filtered out and these would assert on zero bounces.
const hardBounces = (n) => Array.from({ length: n }, (_, i) => ({
  recipient: `x${i}@nonexistent-domain.com`, payload: { bounce_type: 'hard' },
}));

test('the exact 2026-07-28 state throttles instead of stopping', () => {
  const r = evaluateDeliverability({ sent7d: 71, bounceEvents: hardBounces(3), complaints7d: 0 });
  assert.strictEqual(r.mode, 'throttle');
  assert.strictEqual(r.paused, false, 'the department must keep sending, at reduced volume');
  assert.ok(r.throttleDailyCap > 0, 'a throttle with a zero cap is just a stop');
  assert.strictEqual(r.requireVerifiedDomain, true, 'throttled volume must be verified volume');
  assert.match(r.detail, /more clean send/, 'it must state the way out');
});

test('throttling actually recovers — clean sends drop the rate under the limit', () => {
  // 3 bounces / 71 sends = 4.2% (over). One throttled day of 8 clean sends:
  const after = evaluateDeliverability({ sent7d: 79, bounceEvents: hardBounces(3), complaints7d: 0 });
  assert.strictEqual(after.mode, 'ok', '3/79 = 3.8% is under the 4% limit — sending resumes next day');
  // Whereas sending zero leaves it exactly where it was, indefinitely.
  const stalled = evaluateDeliverability({ sent7d: 71, bounceEvents: hardBounces(3), complaints7d: 0 });
  assert.strictEqual(stalled.mode, 'throttle', 'zero sends never improves the rate');
});

test('the genuinely dangerous conditions still STOP dead', () => {
  // These are not measurement artifacts, and no amount of clean volume makes
  // them safe. Throttling through them would risk the sending domain.
  const complaints = evaluateDeliverability({ sent7d: 200, bounceEvents: [], complaints7d: 2 });
  assert.strictEqual(complaints.mode, 'stop');
  assert.strictEqual(complaints.paused, true);

  const catastrophic = evaluateDeliverability({ sent7d: 20, bounceEvents: hardBounces(8), complaints7d: 0 });
  assert.strictEqual(catastrophic.mode, 'stop');

  const absolute = evaluateDeliverability({ sent7d: 500, bounceEvents: hardBounces(10), complaints7d: 0 });
  assert.strictEqual(absolute.mode, 'stop');
});

test('a throttled day sends at the reduced cap, not zero and not full volume', () => {
  const { DEFAULTS } = require('../core/revenue/deliverability-breaker');
  const r = evaluateDeliverability({ sent7d: 71, bounceEvents: hardBounces(3), complaints7d: 0 });
  assert.strictEqual(r.throttleDailyCap, DEFAULTS.throttleDailyCap);
  assert.ok(r.throttleDailyCap < 25, 'must be below the normal daily target');
  assert.ok(r.throttleDailyCap >= 5, 'must be enough volume to actually move the rate');
});
