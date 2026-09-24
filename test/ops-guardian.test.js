'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { maxGapHoursForCron, buildCadenceMap, errorSignature, classifyError } = require('../core/ops-guardian/diagnose');
const { _internal } = require('../core/ops-guardian');

test('stale processing rows remain visible after the recent-health window expires', () => {
  const recent = [
    { id: 'current-complete', status: 'completed' },
    { id: 'current-processing', status: 'processing' },
  ];
  const allProcessing = [
    { id: 'current-processing', status: 'processing' },
    { id: 'months-old-processing', status: 'processing' },
  ];
  assert.deepStrictEqual(
    _internal.mergeJobInventories(recent, allProcessing).map((row) => row.id),
    ['current-complete', 'current-processing', 'months-old-processing'],
  );

  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../core/ops-guardian/index.js'), 'utf8',
  );
  assert.match(source, /\.eq\('status', 'processing'\)/);
  assert.match(source, /agent_jobs_processing_read_failed/);
});

test('stuck-job recovery retains each original bounded payload and caps one recovery pass', () => {
  const entries = _internal.stuckRetryEntries(
    ['job-a', 'job-b', 'job-c'],
    {
      'job-a': { evidence_recovery: true, recovery_priority: 'general', limit: 25 },
      'job-b': { lead_id: 'lead-2' },
      'job-c': null,
    },
    2,
  );
  assert.deepStrictEqual(entries, [
    {
      id: 'job-a',
      payload: { evidence_recovery: true, recovery_priority: 'general', limit: 25 },
    },
    { id: 'job-b', payload: { lead_id: 'lead-2' } },
  ]);
});

test('stuck-job replay is conditionally claimed for the exact FGA tenant', async () => {
  const calls = [];
  const fakeDb = {
    from(table) {
      const state = { table, filters: [], patch: null };
      calls.push(state);
      return {
        update(patch) { state.patch = patch; return this; },
        eq(column, value) { state.filters.push([column, value]); return this; },
        select() { return this; },
        maybeSingle() { return Promise.resolve({ data: { id: 'job-a' }, error: null }); },
      };
    },
  };

  assert.equal(await _internal.claimStuckJobForRecovery(fakeDb, 'job-a'), true);
  assert.deepStrictEqual(calls[0].filters, [
    ['id', 'job-a'],
    ['tenant_id', require('../core/config').FGA_TENANT_ID],
    ['status', 'processing'],
  ]);
  assert.equal(calls[0].patch.status, 'failed');
});

test('a completed job loses the recovery race and is not claimable for replay', async () => {
  const fakeDb = {
    from() {
      return {
        update() { return this; },
        eq() { return this; },
        select() { return this; },
        maybeSingle() { return Promise.resolve({ data: null, error: null }); },
      };
    },
  };
  assert.equal(await _internal.claimStuckJobForRecovery(fakeDb, 'already-complete'), false);
});

test('maxGapHoursForCron — cadence estimation', () => {
  assert.strictEqual(maxGapHoursForCron('0 6 * * *'), 26, 'daily ~26h');
  assert.strictEqual(maxGapHoursForCron('15 * * * *'), 3, 'hourly ~3h');
  assert.strictEqual(maxGapHoursForCron('0 11 * * 1,3,5'), 74, 'Mon/Wed/Fri largest gap (Fri→Mon)');
  assert.strictEqual(maxGapHoursForCron('0 9 * * 1-5'), 74, 'weekdays (Fri→Mon)');
  assert.strictEqual(maxGapHoursForCron('40 18 * * 0'), 170, 'weekly = 168h + grace');
  assert.ok(maxGapHoursForCron('0 8 1 * *') > 700, 'monthly is large');
  // Window schedules: silence over nights/weekends is normal — must NOT read as ~3h.
  assert.ok(maxGapHoursForCron('0,30 9-11 * * 1-5') >= 60, 'drip-campaign window (weekend gap), not 3h');
  assert.ok(maxGapHoursForCron('15 8-18 * * 1-5') >= 60, 'hourly-window weekdays (weekend gap), not 3h');
  assert.ok(maxGapHoursForCron('0 8,14 * * 1-5') >= 50, 'meeting-prep twice-daily weekdays, not 3h');
});

test('buildCadenceMap — conditional vs unconditional', () => {
  const m = buildCadenceMap([
    { agent: 'prospecting', cron: '0 6 * * *', desc: 'daily' },
    { agent: 'content-concept-finalize', cron: '5 11 * * 1', when: () => true, desc: 'gated' },
    { agent: 'prospecting', cron: '0 9 * * 1', desc: 'weekly extra' }, // most-frequent wins
  ]);
  assert.strictEqual(m['prospecting'].unconditional, true);
  assert.strictEqual(m['prospecting'].maxGapHours, 26, 'min gap across entries');
  assert.strictEqual(m['content-concept-finalize'].unconditional, false, 'gated agents are not staleness-eligible');
});

test('errorSignature — normalizes volatile bits', () => {
  const a = errorSignature('Invalid response body while trying to fetch https://api.anthropic.com/v1/messages: Premature close');
  assert.ok(a.includes('premature close'));
  assert.ok(!a.includes('https'), 'urls stripped');
  // same error with a different id/number collapses to the same signature
  const s1 = errorSignature('job 12345 failed with code 502');
  const s2 = errorSignature('job 67890 failed with code 502');
  assert.strictEqual(s1, s2, 'ids/numbers collapse so repeats are detectable');
});

test('classifyError — root cause + permission level', () => {
  // REVERSED 2026-09-24. Caps were level 0 ("by design, no action"). The
  // guardian only watches the PLATFORM's own agents, so an exhausted quota
  // means FGA's sales department has stopped; on Sep 21-24 that was escalated
  // as "Unclear root cause" while follow-ups, prospecting and drafting were
  // all dark. A quota wall now escalates with the meter named.
  const cap = classifyError('Tenant x hit cap on email_send_count: 500/500');
  assert.strictEqual(cap.level, 2, 'a platform quota wall needs the owner');
  assert.strictEqual(cap.category, 'usage_cap');
  const pc = classifyError('Invalid response body ... Premature close');
  assert.strictEqual(pc.recoverable, false);
  assert.strictEqual(pc.level, 2, 'code-level network → approval');
  const rl = classifyError('429 Too Many Requests rate limit');
  assert.strictEqual(rl.recoverable, true);
  assert.strictEqual(rl.level, 1, 'rate limit → safe retry');
  assert.strictEqual(classifyError('401 invalid api key').level, 2, 'auth → approval');
  assert.strictEqual(classifyError('out of credits').level, 2, 'quota → approval');
  assert.strictEqual(classifyError('totally novel failure mode').level, 3, 'unknown → escalate');
  assert.strictEqual(classifyError('No JSON object found in response').category, 'parser');
});
