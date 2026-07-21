/**
 * AI-pace guard (2026-07-21): the Tuesday full-quota prospecting run made
 * ~340 Claude calls in its hour and false-fired the ai-safety agent_per_hour
 * tripwire (then 300). Two-part fix, both pinned here:
 *   1. The watermark default is 400 — high enough that the weekly full-quota
 *      run never cries wolf, low enough to catch a genuine runaway loop.
 *   2. Prospecting self-paces 50 calls BELOW whatever the watermark is, so
 *      the alert email only ever means something is actually wrong.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('agent_per_hour watermark default is 400 (env still overrides)', () => {
  delete process.env.AI_MAX_CALLS_PER_AGENT_PER_HOUR;
  const { thresholds } = require('../core/ai-safety/flags');
  assert.strictEqual(thresholds.maxCallsPerAgentPerHour(), 400);

  process.env.AI_MAX_CALLS_PER_AGENT_PER_HOUR = '250';
  assert.strictEqual(thresholds.maxCallsPerAgentPerHour(), 250, 'env override must win');
  delete process.env.AI_MAX_CALLS_PER_AGENT_PER_HOUR;
});

test('prospecting pace limit sits 50 under the watermark, floored at 50', () => {
  // Mirror of the paceLimit expression in worker/agents/prospecting.js.
  const paceLimit = (watermark) => Math.max(50, watermark - 50);
  assert.strictEqual(paceLimit(400), 350, 'default watermark -> pace at 350');
  assert.strictEqual(paceLimit(300), 250);
  assert.strictEqual(paceLimit(60), 50, 'floor keeps tiny watermarks workable');
});

test('the guard is wired into the prospecting candidate loop', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'worker', 'agents', 'prospecting.js'), 'utf8');
  assert.match(src, /hourly_ai_pace_guard/, 'stop reason present');
  assert.match(src, /maxCallsPerAgentPerHour/, 'reads the SAME watermark the alert uses — they cannot drift');
  assert.match(src, /countCalls\(\{ minutes: 60, agentName: 'prospecting' \}\)/, 'counts the same rolling window the alert counts');
});
