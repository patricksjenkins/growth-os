'use strict';

/**
 * A monitor that can only see half its window is worse than no monitor.
 *
 * WHY (2026-08-10, 6:00am, two CRITICAL pages to Patrick's phone)
 * The Operations Guardian reported `bookkeeping` and `clients-manager` as
 * "no successful run ... has not succeeded in 496210h". 496210 hours is 56.6
 * years — the age of the unix epoch — which is what you get when a timestamp
 * is missing and the code falls back to 0. Both agents had in fact run every
 * Monday for a month with a 100% success rate.
 *
 * The cause was not the guardian's logic. It was the read underneath it:
 *
 *     .from('agent_jobs') ... .gte('created_at', eightDaysAgo).limit(5000)
 *
 * PostgREST caps a response at 1000 rows and does NOT say so — no error, no
 * flag, just fewer rows. FGA had 1468 agent_jobs in that window, so the
 * guardian asked for 8 days and received the newest ~5.5. Both agents run
 * WEEKLY, so their last success sat 7 days back, outside the slice that came
 * through, and the guardian concluded they had never succeeded.
 *
 * The blind spot MOVES: the busier the platform gets, the fewer days 1000
 * rows covers, so this defect widens on its own and eventually reaches
 * daily agents.
 *
 * These tests execute the real code against a client that enforces the same
 * 1000-row ceiling the live API does. A double that honours `.limit(5000)`
 * would make the broken version look correct — which is exactly why the
 * defect survived to production.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { fetchAllRows, PAGE_SIZE } = require('../db/client');

assert.strictEqual(PAGE_SIZE, 1000, 'the ceiling under test is PostgREST\'s default');

/**
 * A query double that behaves like the real API: it applies `.range()`
 * honestly, and NEVER returns more than PAGE_SIZE rows no matter what is
 * asked for. `.limit(n)` is accepted and then quietly ignored above the cap,
 * exactly as PostgREST does.
 */
function pagedTable(rows) {
  let calls = 0;
  const api = (from, to) => {
    calls += 1;
    const width = Math.min(to - from + 1, PAGE_SIZE);
    return Promise.resolve({ data: rows.slice(from, from + width), error: null });
  };
  api.calls = () => calls;
  return api;
}

test('a request spanning several pages returns every row, not the first 1000', async () => {
  const rows = Array.from({ length: 1468 }, (_, i) => ({ i }));
  const { data, error, truncated } = await fetchAllRows(pagedTable(rows));
  assert.strictEqual(error, null);
  assert.strictEqual(truncated, false);
  assert.strictEqual(data.length, 1468, 'this is the live number that broke the guardian');
  assert.strictEqual(data[1467].i, 1467, 'the OLDEST row is the one that was being lost');
});

test('an exact multiple of the page size still terminates', async () => {
  const rows = Array.from({ length: 2000 }, (_, i) => ({ i }));
  const { data } = await fetchAllRows(pagedTable(rows));
  assert.strictEqual(data.length, 2000);
});

test('a single short page costs exactly one request', async () => {
  const t = pagedTable(Array.from({ length: 12 }, (_, i) => ({ i })));
  const { data } = await fetchAllRows(t);
  assert.strictEqual(data.length, 12);
  assert.strictEqual(t.calls(), 1, 'small reads must not pay for pagination');
});

test('an empty result is empty, not an infinite loop', async () => {
  const { data, truncated } = await fetchAllRows(pagedTable([]));
  assert.deepStrictEqual(data, []);
  assert.strictEqual(truncated, false);
});

test('a read error stops immediately and is reported, never silently partial', async () => {
  let n = 0;
  const failOnSecondPage = (from, to) => {
    n += 1;
    if (n === 2) return Promise.resolve({ data: null, error: { message: 'connection reset' } });
    return Promise.resolve({ data: Array.from({ length: to - from + 1 }, (_, i) => ({ i })), error: null });
  };
  const { error, data } = await fetchAllRows(failOnSecondPage);
  assert.ok(error, 'a failed page must surface as an error');
  assert.match(error.message, /connection reset/);
  assert.strictEqual(data.length, PAGE_SIZE, 'partial data is returned WITH the error, not instead of it');
});

test('hitting the cap is announced, because a silent cap is the original bug', async () => {
  const rows = Array.from({ length: 5000 }, (_, i) => ({ i }));
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (m) => warnings.push(String(m));
  try {
    const { data, truncated } = await fetchAllRows(pagedTable(rows), { cap: 2000 });
    assert.strictEqual(data.length, 2000);
    assert.strictEqual(truncated, true, 'the caller must be able to tell it got a partial answer');
    assert.ok(warnings.some((w) => /incomplete/i.test(w)), 'and it must be visible in the logs');
  } finally { console.warn = realWarn; }
});

// ---------------------------------------------------------------------------
// The actual regression: a weekly agent, seen through a truncating client.
// ---------------------------------------------------------------------------

test('a weekly agent that succeeded 7 days ago is NOT reported as never having run', async () => {
  const DAY = 86400_000;
  const now = Date.UTC(2026, 7, 10, 10, 0, 26);
  const iso = (ms) => new Date(ms).toISOString();

  // Reproduce the live shape: 1468 rows over 8 days, with the weekly agent's
  // only success at the far end — position ~1400, past the 1000-row cliff.
  const rows = [];
  rows.push({ id: 'j-new', agent_name: 'bookkeeping', status: 'processing',
    created_at: iso(now - 25_000), started_at: null, completed_at: null, error: null });
  for (let i = 0; i < 1466; i++) {
    rows.push({ id: `noise-${i}`, agent_name: 'system-monitor', status: 'completed',
      created_at: iso(now - (i + 1) * (5.5 * DAY / 1466)), completed_at: iso(now), error: null });
  }
  rows.push({ id: 'j-week', agent_name: 'bookkeeping', status: 'completed',
    created_at: iso(now - 7 * DAY), started_at: iso(now - 7 * DAY),
    completed_at: iso(now - 7 * DAY + 32_000), error: null });

  // What the OLD code saw: one page, and it stops there.
  const firstPageOnly = rows.slice(0, PAGE_SIZE);
  assert.ok(!firstPageOnly.some((r) => r.id === 'j-week'),
    'fixture must reproduce the cliff — the weekly success is past row 1000');

  // What the fix sees.
  const { data } = await fetchAllRows(pagedTable(rows), { cap: 20000 });
  const success = data.find((r) => r.agent_name === 'bookkeeping' && r.status === 'completed');
  assert.ok(success, 'the weekly success must survive the read');

  // And the guardian's staleness arithmetic on that value.
  const lastOk = new Date(success.completed_at).getTime();
  const maxGapHours = 170;                      // weekly cron + grace
  const staleMs = maxGapHours * 3600_000 * 1.4 + 2 * 3600_000;
  assert.ok(now - lastOk < staleMs, 'a 7-day-old success is well inside a weekly agent\'s tolerance');

  // The old path, stated as the number Patrick was actually paged with.
  const lostOk = 0;
  assert.strictEqual(Math.round((now - lostOk) / 3600_000), 496210,
    'this is the exact "496210h" from the 6am alert — a missing timestamp, not a broken agent');
});
