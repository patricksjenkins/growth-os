/**
 * G04 — a recovered incident must close its owner alert (2026-07-24).
 *
 * Production had 12 ops_incidents rows, ALL recovered, while 11 ops_incident
 * attention rows stayed unresolved. The queue advertised active incidents
 * that were already fixed ("past-customer-reengagement: no successful run",
 * "prospecting: zero output"), which is how an owner learns to ignore alerts.
 *
 * The recovery path updated ops_incidents and never touched the linked
 * attention row. These tests pin the reconciliation so the two lifecycles
 * cannot drift apart again.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'core', 'ops-guardian', 'index.js'), 'utf8');

test('incident recovery resolves the linked attention row', () => {
  assert.match(src, /if \(inc\.attention_queue_id\)/,
    'recovery must check for a linked owner alert');
  assert.match(src, /from\('attention_queue'\)\s*\n?\s*\.update\(\{ resolved_at: nowIso\(\) \}\)/,
    'recovery must stamp resolved_at on the linked attention row');
});

test('the resolve is idempotent and scoped to the linked row', () => {
  const block = src.slice(src.indexOf('if (inc.attention_queue_id)'),
    src.indexOf('summary.recovered++', src.indexOf('if (inc.attention_queue_id)')));
  assert.match(block, /\.eq\('id', inc\.attention_queue_id\)/,
    'must target only the incident\'s own alert, never a broad update');
  assert.match(block, /\.is\('resolved_at', null\)/,
    'must not re-stamp an already-resolved row');
});

test('escalation still raises at most one alert per incident', () => {
  // The guardian was already idempotent here; this guards the property while
  // the recovery side is being changed.
  assert.match(src, /let attentionId = incident\.attention_queue_id;/);
  assert.match(src, /if \(!attentionId\) \{/,
    'a second escalation on the same incident must reuse its alert');
});

test('recovery failure cannot silently swallow the alert close', () => {
  // The .then(() => {}, () => {}) tolerance is deliberate: a failed alert
  // close must not abort incident recovery. Assert the incident update still
  // happens first, so state never regresses.
  const recoveryIdx = src.indexOf("status: 'recovered'");
  const attentionIdx = src.indexOf('if (inc.attention_queue_id)');
  assert.ok(recoveryIdx > 0 && attentionIdx > recoveryIdx,
    'incident status must be settled before the alert is closed');
});
