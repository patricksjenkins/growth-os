'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { makeDb } = require('./growth/_stub');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';

const dripAgent = require('../worker/agents/drip-campaign');
const {
  isStaleSendingClaim,
  STALE_SEND_CLAIM_MS,
  isSuppressed,
  preSendCheck,
  isDripSendsPaused,
  isWithinSendWindow,
  sendWindowPosition,
  resolveTimezoneForLead,
  resolveTimezoneForEnrollment,
  outboundRuntimeConfiguration,
} = require('../core/drip-campaign');
const {
  processDueBatch,
  quarantineLegacyEnrollments,
  failureMetadata,
  MAX_SENDS_PER_RUN,
  MAX_SENDS_PER_DAY,
  MAX_CANDIDATES_PER_RUN,
  MAX_FAILURES_PER_TOUCH,
  dailyLimitForDeliverability,
  configuredFollowupDailyCap,
  publicDeliverabilityState,
  claimedToday,
  resolveRunClock,
  readResumableEnrollments,
  readDueEnrollments,
  isUniqueClaimConflict,
  claimDripSend,
  persistAcceptedDripReceipt,
  dripOutcomeContract,
} = dripAgent._test;

test('follow-up capacity can sustain 25 seven-touch starts per day without bypassing the breaker', () => {
  assert.strictEqual(MAX_SENDS_PER_RUN, 30);
  assert.strictEqual(MAX_SENDS_PER_DAY, 150);
  assert.strictEqual(configuredFollowupDailyCap(), 150);
  assert.strictEqual(configuredFollowupDailyCap('60'), 60, 'production may lower the reviewed ceiling');
  assert.strictEqual(configuredFollowupDailyCap('999'), 150, 'environment cannot silently widen the reviewed ceiling');
  assert.strictEqual(dailyLimitForDeliverability({ deliverabilityPaused: true }), 0);
  assert.strictEqual(dailyLimitForDeliverability({ throttled: true, dailyRemaining: 4 }), 4);
  const cron = fs.readFileSync(path.join(__dirname, '..', 'worker', 'scheduler', 'cron.js'), 'utf8');
  assert.match(cron, /agent: 'drip-campaign',\s+cron: '0,30 9-17 \* \* \*'/,
    '18 daily sweeps cover U.S. local windows while the 150/day ceiling remains authoritative');
});

test('future clock is available only to a no-send dry run', () => {
  const simulated = resolveRunClock({ dry_run: true, as_of: '2026-09-14T16:30:00Z' });
  assert.equal(simulated.toISOString(), '2026-09-14T16:30:00.000Z');
  assert.throws(() => resolveRunClock({ as_of: '2026-09-14T16:30:00Z' }), /as_of_requires_dry_run/);
  assert.throws(() => resolveRunClock({ dry_run: true, as_of: 'not-a-date' }), /invalid_dry_run_as_of/);
});

test('follow-up runtime configuration is explicit, secret-free, and fails closed', () => {
  assert.deepStrictEqual(outboundRuntimeConfiguration({}), {
    ready: false,
    provider: 'resend',
    unsubscribe_signing_configured: false,
    email_provider_configured: false,
    missing: ['UNSUBSCRIBE_SECRET', 'RESEND_API_KEY'],
  });
  const ready = outboundRuntimeConfiguration({
    UNSUBSCRIBE_SECRET: 'private-signing-material',
    RESEND_API_KEY: 'private-provider-key',
  });
  assert.deepStrictEqual(ready, {
    ready: true,
    provider: 'resend',
    unsubscribe_signing_configured: true,
    email_provider_configured: true,
    missing: [],
  });
  assert.equal(JSON.stringify(ready).includes('private-signing-material'), false);
  assert.equal(JSON.stringify(ready).includes('private-provider-key'), false);
});

test('worker validates cohort-level outbound configuration before provider or due-row work', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'worker', 'agents', 'drip-campaign.js'), 'utf8');
  const configurationCheck = source.indexOf('const runtimeConfiguration = drip.outboundRuntimeConfiguration()');
  const deliverabilityCheck = source.indexOf('const capState = await computeCapState(db, tenant, runClock)');
  const dueRead = source.indexOf('const due = await readDueEnrollments(db, canonicalCampaign.id, runClock)');
  assert.ok(configurationCheck >= 0 && deliverabilityCheck > configurationCheck && dueRead > deliverabilityCheck);
  assert.match(source.slice(configurationCheck, deliverabilityCheck), /drip_outbound_configuration_missing/);
  assert.match(source.slice(configurationCheck, deliverabilityCheck), /success: false/);
});

test('daily follow-up cap counts uncertain claims and fails closed when unreadable', async () => {
  const db = makeDb((ops) => {
    assert.equal(ops.table, 'drip_sends');
    assert.ok(ops.filters.some((f) => f[0] === 'in' && f[1] === 'status'
      && f[2].includes('sent') && f[2].includes('sending')));
    assert.ok(ops.filters.some((f) => f[0] === 'gte' && f[1] === 'created_at'));
    return 4;
  });
  assert.equal(await claimedToday(db, new Date('2026-09-14T16:30:00Z')), 4);

  const failure = failingQuery({ message: 'counter unavailable' });
  await assert.rejects(claimedToday({ from: () => failure }), /drip_daily_claim_count_failed/);
});

test('due and resumable inventory reads cannot become a clean zero on database failure', async () => {
  await assert.rejects(
    readDueEnrollments({ from: () => failingQuery({ message: 'due read unavailable' }) }, 'campaign-1'),
    /drip_due_inventory_failed/,
  );
  await assert.rejects(
    readResumableEnrollments({ from: () => failingQuery({ message: 'resume read unavailable' }) }, 'campaign-1'),
    /drip_resumable_inventory_failed/,
  );
});

test('only a unique collision is a safe no-op when claiming a follow-up send', async () => {
  assert.equal(isUniqueClaimConflict({ code: '23505', message: 'hidden' }), true);
  assert.equal(isUniqueClaimConflict({ code: '08006', message: 'connection failed' }), false);

  const uniqueDb = { from: () => claimQuery({ data: null, error: { code: '23505', message: 'unique constraint' } }) };
  assert.deepEqual(await claimDripSend(uniqueDb, { id: 'claim' }), {
    claimed: false, reason: 'touch_already_claimed',
  });
  const failedDb = { from: () => claimQuery({ data: null, error: { code: '08006', message: 'connection failed' } }) };
  await assert.rejects(claimDripSend(failedDb, { id: 'claim' }), /drip_send_claim_failed:connection failed/);
});

test('provider acceptance must be persisted before the follow-up can advance', async () => {
  const observed = {};
  const goodDb = { from: (table) => receiptQuery({ data: { id: 'send-1' }, error: null }, observed, table) };
  const receipt = await persistAcceptedDripReceipt(goodDb, {
    sendRowId: 'send-1', providerId: 'provider-1', html: '<p>delivered</p>', sentAt: '2026-09-14T14:00:00Z',
  });
  assert.equal(receipt.id, 'send-1');
  assert.equal(observed.table, 'drip_sends');
  assert.equal(observed.update.status, 'sent');
  assert.equal(observed.update.resend_id, 'provider-1');
  assert.ok(observed.filters.some((f) => f[0] === 'eq' && f[1] === 'tenant_id'));

  const failedDb = { from: () => receiptQuery({ data: null, error: { message: 'write unavailable' } }, {}) };
  await assert.rejects(
    persistAcceptedDripReceipt(failedDb, {
      sendRowId: 'send-1', providerId: 'provider-1', html: '', sentAt: '2026-09-14T14:00:00Z',
    }),
    /drip_provider_receipt_persist_failed:write unavailable/,
  );
  const missingDb = { from: () => receiptQuery({ data: null, error: null }, {}) };
  await assert.rejects(
    persistAcceptedDripReceipt(missingDb, {
      sendRowId: 'send-1', providerId: 'provider-1', html: '', sentAt: '2026-09-14T14:00:00Z',
    }),
    /accepted receipt row missing/,
  );
});

test('the accepted provider receipt is required before cursor advancement in the send path', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'worker', 'agents', 'drip-campaign.js'), 'utf8');
  const persistCall = source.indexOf('await persistAcceptedDripReceipt(db, {');
  const advanceCall = source.indexOf('await advanceCursor(db, fresh, stepDay, lead, { sentOk: true });', persistCall);
  assert.ok(persistCall >= 0, 'the send path must persist provider acceptance');
  assert.ok(advanceCall > persistCall, 'the enrollment cursor cannot advance before the provider receipt is durable');
  assert.match(
    source.slice(persistCall, advanceCall),
    /reason: 'provider_receipt_persist_failed'/,
    'receipt uncertainty must stop before cursor advancement',
  );
});

test('follow-up outcome contract distinguishes not-due, provider acceptance, and failure', () => {
  assert.equal(dripOutcomeContract({ sent: 0, failed: 0, skipped: 0, stopped: 0, rescheduled: 0 }, 0).reason_code, 'no_due_followups');
  assert.equal(dripOutcomeContract({ sent: 2, failed: 0, skipped: 0, stopped: 0, rescheduled: 0 }, 2).business_outcome_state, 'followups_provider_accepted');
  assert.equal(dripOutcomeContract({ sent: 1, failed: 1, skipped: 0, stopped: 0, rescheduled: 0 }, 2).result_state, 'failed');
});

function failingQuery(error) {
  const result = Promise.resolve({ data: null, count: null, error });
  const query = {};
  for (const method of ['select', 'eq', 'in', 'gte', 'lte', 'not', 'order', 'limit']) {
    query[method] = () => query;
  }
  query.then = (resolve, reject) => result.then(resolve, reject);
  return query;
}

function claimQuery(result) {
  const query = {};
  for (const method of ['insert', 'select', 'single']) query[method] = () => query;
  query.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  return query;
}

function receiptQuery(result, observed, table = null) {
  observed.table = table;
  observed.filters = [];
  const query = {
    update(value) { observed.update = value; return query; },
    eq(...args) { observed.filters.push(['eq', ...args]); return query; },
    select() { return query; },
    maybeSingle() { return Promise.resolve(result); },
  };
  return query;
}

test('state evidence resolves nationwide prospect time zones without overriding explicit IANA evidence', () => {
  assert.deepStrictEqual(resolveTimezoneForLead({ hq_state: 'CA' }), {
    timezone: 'America/Los_Angeles', source: 'state_primary_zone', state: 'CA',
  });
  assert.equal(resolveTimezoneForLead({ state: 'Hawaii' }).timezone, 'Pacific/Honolulu');
  assert.equal(resolveTimezoneForLead({ hq_state: 'AK' }).timezone, 'America/Anchorage');
  assert.deepStrictEqual(resolveTimezoneForLead({
    hq_state: 'GA', metadata: { timezone: 'America/Denver' },
  }), { timezone: 'America/Denver', source: 'explicit_iana', state: null });
  assert.equal(resolveTimezoneForLead({ hq_state: 'CA', timezone: 'invalid/tz' }).timezone, 'America/Los_Angeles');
  assert.equal(resolveTimezoneForLead({}).source, 'fga_default');
  assert.deepStrictEqual(
    resolveTimezoneForEnrollment(
      { metadata: { timezone: 'America/New_York' } },
      { hq_state: 'CA' },
    ),
    { timezone: 'America/Los_Angeles', source: 'state_primary_zone', state: 'CA' },
    'legacy enrollment defaults without provenance must self-repair from the lead',
  );
  assert.equal(resolveTimezoneForEnrollment({
    metadata: { timezone: 'America/Chicago', timezone_source: 'explicit_iana' },
  }, { hq_state: 'CA' }).timezone, 'America/Chicago');
});

test('a due row before its local window waits today; only a passed window rolls forward', () => {
  assert.equal(sendWindowPosition(new Date('2026-09-11T13:20:00Z'), 'America/Los_Angeles'), 'before');
  assert.equal(sendWindowPosition(new Date('2026-09-11T16:20:00Z'), 'America/Los_Angeles'), 'inside');
  assert.equal(sendWindowPosition(new Date('2026-09-11T19:20:00Z'), 'America/Los_Angeles'), 'after');
  const source = fs.readFileSync(path.join(__dirname, '..', 'worker/agents/drip-campaign.js'), 'utf8');
  const beforeBranch = source.indexOf("if (windowPosition === 'before')");
  const afterBranch = source.indexOf("if (windowPosition === 'after')");
  assert.ok(beforeBranch >= 0 && afterBranch > beforeBranch);
  assert.match(source.slice(beforeBranch, afterBranch), /reason: 'awaiting_local_send_window'/);
  assert.doesNotMatch(source.slice(beforeBranch, afterBranch), /\.update\(/,
    'waiting for a later same-day local window must not move the enrollment');
});

test('the expanded Eastern schedule intersects every supported U.S. prospect-local morning', () => {
  const zones = [
    'America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix',
    'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu',
  ];
  for (const [date, easternUtcStartHour] of [['2026-01-15', 14], ['2026-07-15', 13]]) {
    const instants = [];
    // Cron is 09:00 through 17:30 America/New_York, every 30 minutes.
    const start = new Date(`${date}T${String(easternUtcStartHour).padStart(2, '0')}:00:00.000Z`);
    for (let minutes = 0; minutes <= 8 * 60 + 30; minutes += 30) {
      instants.push(new Date(start.getTime() + minutes * 60000));
    }
    for (const zone of zones) {
      assert.ok(instants.some((instant) => isWithinSendWindow(instant, zone)),
        `${zone} must receive at least one valid local window on ${date}`);
    }
  }
});

test('legacy campaign enrollments are stopped before follow-up delivery can resume', async () => {
  const calls = [];
  let phase = 'inventory';
  const db = {
    from(table) {
      assert.equal(table, 'drip_enrollments');
      const filters = [];
      const builder = {
        select() { return builder; },
        update(value) { calls.push({ type: 'update', value, filters }); phase = 'update'; return builder; },
        eq(...args) { filters.push(['eq', ...args]); return builder; },
        in(...args) { filters.push(['in', ...args]); return builder; },
        neq(...args) { filters.push(['neq', ...args]); return builder; },
        then(resolve) {
          return Promise.resolve(phase === 'inventory'
            ? { count: 553, error: null }
            : { data: null, error: null }).then(resolve);
        },
      };
      return builder;
    },
  };

  const count = await quarantineLegacyEnrollments(db, 'campaign-v2');
  assert.equal(count, 553);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].value.status, 'stopped');
  assert.equal(calls[0].value.next_send_at, null);
  assert.match(calls[0].value.stopped_reason, /^legacy_campaign_retired:/);
  assert.ok(calls[0].filters.some((f) => f[0] === 'neq' && f[1] === 'campaign_id' && f[2] === 'campaign-v2'));
});

test('legacy campaign dry run counts but does not mutate', async () => {
  let updateCalled = false;
  const builder = {
    select() { return builder; }, eq() { return builder; }, in() { return builder; }, neq() { return builder; },
    update() { updateCalled = true; return builder; },
    then(resolve) { return Promise.resolve({ count: 7, error: null }).then(resolve); },
  };
  const count = await quarantineLegacyEnrollments({ from: () => builder }, 'campaign-v2', { dryRun: true });
  assert.equal(count, 7);
  assert.equal(updateCalled, false);
});

test('a poisoned head cohort cannot starve healthy enrollments behind it', async () => {
  assert.ok(MAX_CANDIDATES_PER_RUN > MAX_SENDS_PER_RUN);
  const due = Array.from({ length: 50 }, (_, index) => ({
    id: `enrollment-${index}`,
    lead_id: `lead-${index}`,
    next_step_day: index < 25 ? 30 : 7,
  }));
  const attempted = [];
  const deferred = [];
  const recorded = [];

  const batch = await processDueBatch(due, {
    dailyBudget: 30,
    processOne: async (enrollment) => {
      attempted.push(enrollment.id);
      if (Number(enrollment.id.split('-')[1]) < 25) {
        throw new Error('permanent coupon configuration failure');
      }
      return { enrollment_id: enrollment.id, bucket: 'sent', day: enrollment.next_step_day };
    },
    handleFailure: async (enrollment) => {
      deferred.push(enrollment.id);
      return { failure_count: 1, next_send_at: '2026-08-17T13:00:00Z' };
    },
    recordOutcome: async (_enrollment, outcome) => recorded.push(outcome),
  });

  assert.strictEqual(batch.results.failed, 25);
  assert.strictEqual(batch.results.sent, 25);
  assert.strictEqual(batch.dailyBudget, 5);
  assert.strictEqual(attempted.length, 50, 'healthy rows behind the poisoned 25 must be attempted');
  assert.strictEqual(deferred.length, 25, 'each poison row is moved out of the queue head');
  assert.strictEqual(recorded.length, 50, 'every evaluated delivery leaves evidence');
});

test('failure counting is per touch and supports bounded quarantine', () => {
  let enrollment = { next_step_day: 30, metadata: {} };
  for (let count = 1; count <= MAX_FAILURES_PER_TOUCH; count++) {
    const metadata = failureMetadata(enrollment, new Error('bad config'));
    assert.strictEqual(metadata.drip_failure_count, count);
    enrollment = { ...enrollment, metadata };
  }
  const nextTouch = failureMetadata({ ...enrollment, next_step_day: 45 }, new Error('new failure'));
  assert.strictEqual(nextTouch.drip_failure_count, 1, 'a later touch gets a fresh retry budget');
});

test('migration adds append-only queryable non-delivery evidence', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db/migrations/105_drip_delivery_attempts.sql'), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.drip_delivery_attempts/);
  assert.match(sql, /outcome IN \('sent', 'skipped', 'stopped', 'failed', 'rescheduled'\)/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.doesNotMatch(sql, /FOR (?:INSERT|UPDATE|DELETE) TO authenticated/);
});

test('an uncertain stale send claim is quarantined instead of retried', () => {
  const now = Date.parse('2026-09-05T16:00:00Z');
  assert.equal(isStaleSendingClaim({
    status: 'sending',
    updated_at: new Date(now - STALE_SEND_CLAIM_MS - 1).toISOString(),
  }, now), true);
  assert.equal(isStaleSendingClaim({
    status: 'sending',
    updated_at: new Date(now - STALE_SEND_CLAIM_MS + 1).toISOString(),
  }, now), false);
  assert.equal(isStaleSendingClaim({
    status: 'sent',
    updated_at: new Date(now - STALE_SEND_CLAIM_MS - 1).toISOString(),
  }, now), false);
});

function failingBuilder(message) {
  const result = Promise.resolve({ data: null, error: { message } });
  const builder = {
    select() { return builder; }, eq() { return builder; }, in() { return builder; },
    limit() { return builder; }, maybeSingle() { return result; },
    then(resolve, reject) { return result.then(resolve, reject); },
  };
  return builder;
}

test('suppression and pre-send reads fail closed on database uncertainty', async () => {
  const db = { from: () => failingBuilder('database unavailable') };
  await assert.rejects(
    isSuppressed(db, 'prospect@example.com'),
    /suppression_check_failed/,
  );
  await assert.rejects(
    preSendCheck(db, { id: 'enrollment-1' }, null),
    /presend_enrollment_read_failed/,
  );
});

test('follow-up suppression uses the central lead, domain, and company boundary', async () => {
  const db = makeDb((ops) => {
    if (ops.table !== 'lead_suppressions') return [];
    const orFilter = ops.filters.find((f) => f[0] === 'or')?.[1] || '';
    if (orFilter.includes('lead_id.eq.lead-1')) {
      return [{ reason: 'owner_blocked', channel: 'email', source: 'owner_ui' }];
    }
    return [];
  });
  const reason = await isSuppressed(db, 'prospect@example.com', {
    id: 'lead-1', company_name: 'Prospect Co', domain: 'example.com',
  });
  assert.equal(reason, 'owner_blocked');
});

test('the outbound-only drip kill switch has fail-safe boolean semantics', () => {
  assert.equal(isDripSendsPaused({ config: { drip_sends_paused: 'true' } }), true);
  assert.equal(isDripSendsPaused({ config: { drip_sends_paused: true } }), true);
  assert.equal(isDripSendsPaused({ config: { drip_sends_paused: 'false' } }), false);
  assert.equal(isDripSendsPaused({ config: {} }), false);
});

test('the worker checks the outbound-only pause after the reply-sync branch', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'worker/agents/drip-campaign.js'), 'utf8');
  const syncBranch = source.indexOf("if (task === 'sync_replies')");
  const sendPause = source.indexOf('if (drip.isDripSendsPaused(tenant))');
  const dueSends = source.indexOf('// ---- process_sends');
  assert.ok(syncBranch >= 0 && sendPause > syncBranch && dueSends > sendPause,
    'reply sync must remain live while outbound follow-ups are paused');
});

test('follow-ups share the first-touch deliverability stop and throttle', () => {
  assert.equal(dailyLimitForDeliverability({ deliverabilityPaused: true, dailyRemaining: 25 }), 0);
  assert.equal(dailyLimitForDeliverability({ deliverabilityPaused: false, throttled: true, dailyRemaining: 6 }), 6);
  assert.equal(dailyLimitForDeliverability({ deliverabilityPaused: false, throttled: false, dailyRemaining: 0 }), 150);

  const publicState = publicDeliverabilityState({
    deliverabilityPaused: false,
    throttled: true,
    sent7d: 77,
    firstTouches7d: 47,
    followups7d: 30,
    hardBounces7d: 3,
    softBounces7d: 1,
    complaints7d: 0,
    bounceRate7d: 3.9,
    suppressCandidates: ['private@example.com'],
  });
  assert.equal(publicState.mode, 'throttle');
  assert.equal(publicState.sent_7d, 77);
  assert.equal(publicState.followups_7d, 30);
  assert.equal('suppressCandidates' in publicState, false, 'attention/result evidence must not expose recipient addresses');
});

test('the shared deliverability decision occurs before any follow-up processing', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'worker/agents/drip-campaign.js'), 'utf8');
  const sharedCheck = source.indexOf('const capState = await computeCapState(db, tenant, runClock)');
  const dueSends = source.indexOf('// ---- process_sends');
  assert.ok(sharedCheck >= 0 && dueSends > sharedCheck,
    'follow-up delivery must fail closed before campaign mutation and provider sends');
  assert.match(source, /skipped: 'deliverability_circuit_breaker'/);
});
