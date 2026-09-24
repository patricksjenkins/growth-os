'use strict';

/**
 * Self-healing: a systemic failure must never be charged to an individual.
 *
 * THE INCIDENT (2026-09-21 .. 24)
 * FGA's own tenant was metered like a Growth customer (500 emails/mo, $10 of
 * AI/mo). On Sep 21 email_send_count hit 500/500. The drip kept going: 277
 * failing attempts in 4 days, a strike charged to every prospect, 56 good
 * follow-ups quarantined into `review` where nothing would release them, and
 * the guardian escalated it all as "Unclear root cause — needs human
 * diagnosis". On Sep 22 the AI meter hit 1002/1000 and prospecting stopped.
 *
 * These tests execute the real functions against that exact error text.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const QUOTA_ERR = 'Tenant 30566ed6-026a-45e1-9502-029e6219df31 hit cap on email_send_count: 500/500';

// ---------------------------------------------------------------------------
// 1. Classification
// ---------------------------------------------------------------------------
const { classifyFailure, describeBlocker } = require('../core/systemic-failure');

test('the real quota error is systemic, and the meter is parsed out', () => {
  const c = classifyFailure(new Error(QUOTA_ERR));
  assert.strictEqual(c.systemic, true);
  assert.strictEqual(c.kind, 'usage_cap');
  assert.strictEqual(c.meter, 'email_send_count');
  assert.strictEqual(c.used, 500);
  assert.strictEqual(c.cap, 500);
  assert.match(describeBlocker(c), /email_send_count quota exhausted \(500\/500\)/);
});

test('a problem with ONE address stays item-level, so quarantine still protects', () => {
  for (const e of [
    '550 5.1.1 Recipient address rejected: mailbox unavailable',
    'coupon_already_redeemed',
    'No such price: price_123',
    'invalid email address',
  ]) {
    assert.strictEqual(classifyFailure(e).systemic, false, `${e} must not be treated as systemic`);
  }
});

// ---------------------------------------------------------------------------
// 2. The platform is not a customer
// ---------------------------------------------------------------------------
const { getCap, TIER_CAPS } = require('../core/usage-caps');
const { FGA_TENANT_ID } = require('../core/config');

test('the platform tenant is not held to Growth customer quotas', () => {
  const fga = { id: FGA_TENANT_ID, tier: 'growth', config: {} };
  assert.ok(getCap(fga, 'email_send_count') > 1500,
    'natural platform volume is ~1,200/mo; 500 blacked out the sales department on Sep 21');
  assert.ok(getCap(fga, 'claude_spend_cents') > 1000,
    'a $10 AI meter stopped prospecting, drafting and reply classification on Sep 22');
});

test('customers keep their plan quotas exactly', () => {
  const client = { id: 'some-client', tier: 'growth', config: {} };
  assert.strictEqual(getCap(client, 'email_send_count'), TIER_CAPS.growth.email_send_count);
  assert.strictEqual(getCap(client, 'claude_spend_cents'), TIER_CAPS.growth.claude_spend_cents);
});

test('an explicit override still beats the platform backstop', () => {
  const fga = { id: FGA_TENANT_ID, tier: 'growth', config: { usage_cap: { email_send_count: 1234 } } };
  assert.strictEqual(getCap(fga, 'email_send_count'), 1234, 'Patrick can always set his own ceiling');
});

// ---------------------------------------------------------------------------
// 3. The drip batch circuit-breaks and charges no strikes
// ---------------------------------------------------------------------------
const drip = require('../worker/agents/drip-campaign')._test;

test('a systemic failure stops the batch at the FIRST enrollment', async () => {
  const due = Array.from({ length: 25 }, (_, i) => ({ id: `e${i}`, next_step_day: 7, metadata: {} }));
  let attempted = 0;
  const handled = [];
  const out = await drip.processDueBatch(due, {
    processOne: async () => { attempted++; throw new Error(QUOTA_ERR); },
    handleFailure: async (enr, err, failure) => { handled.push(failure); return { failure_count: 0 }; },
    log: { error() {}, warn() {} },
  });
  assert.strictEqual(attempted, 1, 'the old loop made 25 identical failing attempts per run');
  assert.strictEqual(out.results.failed, 1);
  assert.strictEqual(out.results.systemic_blocker.kind, 'usage_cap');
  assert.strictEqual(out.results.systemic_blocker.meter, 'email_send_count');
  assert.strictEqual(handled[0].systemic, true, 'the failure handler is told it was systemic');
});

test('an item failure does NOT stop the batch — healthy enrollments still send', async () => {
  const due = [{ id: 'bad', next_step_day: 7 }, { id: 'ok1', next_step_day: 7 }, { id: 'ok2', next_step_day: 7 }];
  const out = await drip.processDueBatch(due, {
    processOne: async (e) => {
      if (e.id === 'bad') throw new Error('550 Recipient address rejected');
      return { enrollment_id: e.id, bucket: 'sent' };
    },
    log: { error() {}, warn() {} },
  });
  assert.strictEqual(out.results.sent, 2);
  assert.strictEqual(out.results.failed, 1);
  assert.ok(!out.results.systemic_blocker);
});

function recordingDb(rows = []) {
  const writes = [];
  const from = (table) => {
    const st = { table, op: null, payload: null, filters: [] };
    const api = {
      select() { st.op = st.op || 'select'; return api; },
      update(p) { st.op = 'update'; st.payload = p; writes.push(st); return api; },
      eq(k, v) { st.filters.push([k, v]); return api; },
      limit() { return Promise.resolve({ data: rows, error: null }); },
      then(res) { return Promise.resolve({ data: null, error: null }).then(res); },
    };
    return api;
  };
  return { from, writes };
}

test('a systemic failure defers the enrollment WITHOUT a strike', async () => {
  const db = recordingDb();
  const enr = { id: 'e1', next_step_day: 7, metadata: { drip_failure_count: 1, drip_failure_day: 7 } };
  const out = await drip.deferFailedEnrollment(db, enr, new Error(QUOTA_ERR), { warn() {} });
  assert.strictEqual(out.quarantined, false);
  assert.strictEqual(out.systemic, true);
  const w = db.writes[0];
  assert.ok(!('status' in w.payload), 'must never move a prospect to review for a system fault');
  assert.strictEqual(w.payload.metadata.drip_failure_count, 1, 'strike count unchanged');
  assert.ok(w.payload.next_send_at, 'rescheduled for the next window');
});

test('an item failure still counts toward quarantine as before', async () => {
  const db = recordingDb();
  const enr = { id: 'e1', next_step_day: 7, metadata: { drip_failure_count: 2, drip_failure_day: 7 } };
  const out = await drip.deferFailedEnrollment(db, enr, new Error('550 Recipient address rejected'), { warn() {} });
  assert.strictEqual(out.quarantined, true, 'the third real strike still quarantines');
});

// ---------------------------------------------------------------------------
// 4. Self-heal: release what a systemic failure quarantined
// ---------------------------------------------------------------------------

test('follow-ups quarantined by the quota are released; genuinely broken ones stay', async () => {
  const db = recordingDb([
    { id: 'quota-victim', metadata: { drip_failure_count: 3, drip_last_failure: QUOTA_ERR } },
    { id: 'bad-address', metadata: { drip_failure_count: 3, drip_last_failure: '550 mailbox unavailable' } },
  ]);
  const released = await drip.releaseSystemicQuarantines(db, { info() {}, warn() {} });
  assert.strictEqual(released, 1);
  const updates = db.writes.filter((w) => w.op === 'update');
  assert.strictEqual(updates.length, 1, 'only the systemic victim is touched');
  const u = updates[0];
  assert.ok(u.filters.some(([k, v]) => k === 'id' && v === 'quota-victim'));
  assert.strictEqual(u.payload.status, 'active');
  assert.strictEqual(u.payload.paused_reason, null);
  assert.ok(!('drip_failure_count' in u.payload.metadata), 'strikes cleared');
  assert.ok(u.filters.some(([k, v]) => k === 'paused_reason' && v === 'repeated_delivery_failure'),
    'guarded: only releases the exact quarantine state it created');
});

// ---------------------------------------------------------------------------
// 5. Diagnosis: the guardian names the cause, and sees it coming
// ---------------------------------------------------------------------------
const { classifyError, projectUsageHeadroom } = require('../core/ops-guardian/diagnose');

test('the guardian no longer calls a quota wall "Unclear root cause"', () => {
  const c = classifyError(QUOTA_ERR);
  assert.strictEqual(c.category, 'usage_cap');
  assert.ok(c.level >= 2, 'the sales department going dark is not informational');
  assert.doesNotMatch(c.cause, /unclear/i);
  assert.match(c.cause, /email_send_count/);
});

test('the drip job error now carries the blocker for the guardian to read', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../worker/agents/drip-campaign.js'), 'utf8');
  assert.match(src, /Drip blocked: \$\{results\.systemic_blocker\.detail\}/);
});

test('headroom projection warns before the wall, not after', () => {
  const caps = { email_send_count: 500 };
  const at = (day, used) => projectUsageHeadroom({
    usage: { email_send_count: used }, caps, now: new Date(Date.UTC(2026, 8, day, 12)),
  });
  // Mid-month at September's pace: flagged at_risk with a date before the 30th.
  const early = at(15, 320);
  assert.strictEqual(early.length, 1);
  assert.strictEqual(early[0].state, 'at_risk');
  assert.ok(early[0].exhaustsOn < '2026-09-30');
  // On pace to finish under the cap: silent.
  assert.deepStrictEqual(at(15, 100), []);
  // Exhausted: red.
  assert.strictEqual(at(24, 500)[0].state, 'exhausted');
});
