'use strict';

/**
 * Discovery rotation — the overlap bug that produced 39% duplicates.
 *
 * MEASURED, 2026-07-30: over 10 days prospecting discovered 247 companies —
 * 97 (39.3%) were duplicates we had already paid Serper to find, 76 (30.8%)
 * had no reachable contact, and only 74 (30.0%) became usable leads. That is
 * ~7.4 qualified/day against a send target of 25/day.
 *
 * The cause was arithmetic, not data. `dayOffset` advances by ONE per day, but
 * a run consumes maxSerperCalls / QUERIES_PER_PAIR pairs — 10 at the current
 * budget. Starting at index N one day and N+1 the next meant NINE OF TEN pairs
 * repeated, so identical queries went to Serper and identical companies came
 * back.
 *
 * Stepping by the window makes consecutive runs disjoint at no extra API cost.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { buildDiscoveryQueries, QUERIES_PER_PAIR } = require('../worker/agents/prospecting');

const INDUSTRIES = ['Plumbing', 'HVAC', 'Electrical', 'Roofing'];
const STATES = ['GA', 'FL', 'AL', 'TN', 'SC', 'NC', 'MS', 'LA', 'VA', 'KY', 'AR', 'TX', 'OK', 'MO'];
const CALLS = 30;
const DAY = 20300;

test('consecutive days query DIFFERENT pairs — no overlap', () => {
  const today = new Set(buildDiscoveryQueries(INDUSTRIES, STATES, CALLS, DAY));
  const tomorrow = new Set(buildDiscoveryQueries(INDUSTRIES, STATES, CALLS, DAY + 1));
  const overlap = [...today].filter((q) => tomorrow.has(q)).length;
  assert.strictEqual(overlap, 0,
    `${overlap} of ${today.size} queries repeat — every repeat is a Serper call spent rediscovering a known company`);
});

test('a week of runs covers distinct ground', () => {
  const seen = new Set();
  let total = 0;
  for (let d = 0; d < 7; d++) {
    const qs = buildDiscoveryQueries(INDUSTRIES, STATES, CALLS, DAY + d);
    total += qs.length;
    qs.forEach((q) => seen.add(q));
  }
  // With 4x14 = 56 pairs and 10 pairs/run, 7 days = 70 pair-slots, so some
  // wrap is expected — but nothing like the old 90%-a-day repeat.
  const uniquePct = (seen.size / total) * 100;
  assert.ok(uniquePct >= 75,
    `only ${uniquePct.toFixed(0)}% of a week's queries were unique`);
});

test('the step matches the number of pairs a run actually consumes', () => {
  // The bug in one line: the window advanced by 1 while consuming N.
  const pairsPerRun = Math.floor(CALLS / QUERIES_PER_PAIR);
  assert.strictEqual(pairsPerRun, 10, 'sanity: 30 calls / 3 per pair');
  const a = buildDiscoveryQueries(INDUSTRIES, STATES, CALLS, DAY);
  // Day+1 must begin exactly where day ended, not one pair along.
  const b = buildDiscoveryQueries(INDUSTRIES, STATES, CALLS, DAY + 1);
  assert.notStrictEqual(a[0], b[0]);
  assert.ok(!a.includes(b[0]), "the next run's first query must not be inside the previous run");
});

test('a smaller budget still rotates without overlap', () => {
  // 9 calls = 3 pairs/run. The step must follow the budget, not a constant.
  const a = new Set(buildDiscoveryQueries(INDUSTRIES, STATES, 9, DAY));
  const b = new Set(buildDiscoveryQueries(INDUSTRIES, STATES, 9, DAY + 1));
  assert.strictEqual([...a].filter((q) => b.has(q)).length, 0);
});

test('the query set is still capped by the Serper budget', () => {
  assert.strictEqual(buildDiscoveryQueries(INDUSTRIES, STATES, 30, DAY).length, 30);
  assert.strictEqual(buildDiscoveryQueries(INDUSTRIES, STATES, 6, DAY).length, 6);
  assert.deepStrictEqual(buildDiscoveryQueries([], STATES, 30, DAY), []);
});
