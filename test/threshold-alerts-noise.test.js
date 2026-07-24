/**
 * Threshold alerts must not become a daily archive (2026-07-24).
 *
 * threshold-alerts runs every morning and used to INSERT unconditionally, so
 * every rule it tripped re-raised daily and nothing resolved: 35 open
 * concentration_risk rows, 13 agent_streak_failure, 10 mrr_drop — 58 rows
 * restating three facts. Patrick: "stop the daily alert, I know I only have
 * 2 paying customers."
 *
 * Two properties pinned here:
 *   1. concentration risk is silent below a meaningful client count (with 1-2
 *      paying clients the percentage is arithmetic, not a signal)
 *   2. a condition already open is never raised again
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'worker', 'agents', 'threshold-alerts.js');
const src = fs.readFileSync(SRC, 'utf8');

test('concentration risk is gated on a meaningful number of paying clients', () => {
  assert.match(src, /const MIN_CLIENTS_FOR_CONCENTRATION = (\d+)/,
    'the floor must be a named constant, not a magic number');
  const floor = Number(src.match(/const MIN_CLIENTS_FOR_CONCENTRATION = (\d+)/)[1]);
  assert.ok(floor >= 3,
    `below 3 clients the ratio is arithmetic, not insight (floor is ${floor})`);
  assert.match(src, /payingClients < MIN_CLIENTS_FOR_CONCENTRATION\) return null/,
    'the rule must return null — not raise a suppressed row');
  assert.match(src, /mrrs\.filter\(\(m\) => m > 0\)\.length/,
    'paying clients means MRR > 0, not merely an active tenant row');
});

test('an already-open condition is never re-raised', () => {
  assert.match(src, /\.is\('resolved_at', null\)/,
    'the writer must look for an UNRESOLVED row of the same type first');
  assert.match(src, /if \(alreadyOpen\) return false/,
    'a repeat must short-circuit before the insert');
  assert.match(src, /\.limit\(/, 'the existence check must be limited');
});

test('a repeat does not re-notify Patrick either', () => {
  // Every _push must sit behind the "did we actually raise it" check —
  // otherwise the row stops duplicating but the phone still buzzes daily.
  const pushes = src.match(/await _push\(/g) || [];
  const guarded = src.match(/if \(await _writeQueueItem\([\s\S]*?\)\) \{\s*\n\s*await _push\(/g) || [];
  assert.strictEqual(guarded.length, pushes.length,
    `every push must be gated on a NEW alert (${pushes.length} pushes, ${guarded.length} guarded)`);
});

test('parallel conditions can still coexist (one row per failing agent)', () => {
  assert.match(src, /const key = \{ field: 'agent', value: f\.agent \}/,
    'agent streak alerts key on the agent so two failing agents both surface');
  assert.match(src, /key == null \? true : String\(row\.payload\?\.\[key\.field\]/,
    'the dedupe must compare the key field when one is supplied');
});
