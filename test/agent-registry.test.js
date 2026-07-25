/**
 * Every agent that something enqueues by name MUST be registered.
 *
 * Why this file exists: revenue-guardian shipped with five cron checkpoints
 * and no registry entry. Every checkpoint would have failed with "Unknown
 * agent" — silently, from the CEO's seat, which is the exact failure this
 * department was rebuilt to eliminate. The guardian's own tests passed because
 * they asserted the cron entries existed and grepped source text; nothing
 * asserted the agent could actually be resolved and run.
 *
 * A name is enqueued in three places: the cron schedule, an agent that queues
 * follow-on work, and API routes that trigger a run. All three are checked
 * against the one production registry in api/server.js.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

/** Agent names registered in the production registry (api/server.js agentDefs). */
function registeredAgents() {
  const src = read('api', 'server.js');
  const block = src.slice(src.indexOf('const agentDefs = ['));
  const end = block.indexOf('\n    ];');
  assert.ok(end > 0, 'could not locate the end of the agentDefs array');
  return new Set(
    [...block.slice(0, end).matchAll(/\['([a-z0-9-]+)',\s*'\.\.\/worker\/agents\//g)].map((m) => m[1]),
  );
}

/** Agent names the cron scheduler enqueues. */
function cronAgents() {
  return new Set([...read('worker', 'scheduler', 'cron.js').matchAll(/\bagent:\s*'([a-z0-9-]+)'/g)]
    .map((m) => m[1]));
}

test('the registry parses and is non-trivial', () => {
  const reg = registeredAgents();
  assert.ok(reg.size > 30, `expected a full registry, parsed ${reg.size}`);
  assert.ok(reg.has('auto-outreach'), 'sanity: the sender must be registered');
});

test('EVERY cron-scheduled agent is registered', () => {
  const reg = registeredAgents();
  const missing = [...cronAgents()].filter((a) => !reg.has(a));
  assert.deepStrictEqual(missing, [],
    `cron enqueues agents that cannot run: ${missing.join(', ')}`);
});

test('revenue-guardian specifically is registered and loadable', () => {
  // Named explicitly: this is the regression. The generic test above would
  // also catch it, but a failure here names the culprit directly.
  assert.ok(registeredAgents().has('revenue-guardian'),
    'revenue-guardian has five cron checkpoints; without a registry entry every one is a no-op');
  assert.strictEqual(typeof require('../worker/agents/revenue-guardian'), 'function',
    'the module must export a callable agent');
});

test('every agent the guardian enqueues is registered', () => {
  // Read the targets as exported DATA, not by pattern-matching source. The
  // first version of this test scraped `agent_name:` literals and lost sight
  // of two targets the moment they moved into a loop variable.
  const { REMEDIATION_TARGETS, REMEDIATIONS } = require('../worker/agents/revenue-guardian');
  const reg = registeredAgents();
  const targets = [...new Set(Object.values(REMEDIATION_TARGETS).flat())];

  assert.deepStrictEqual(
    Object.keys(REMEDIATION_TARGETS).sort(), Object.keys(REMEDIATIONS).sort(),
    'every remediation must declare its queue targets, so none can be added unnoticed');
  assert.ok(targets.length >= 4, `expected the Tier-1 remediation targets, found ${targets.length}`);

  const missing = targets.filter((a) => !reg.has(a));
  assert.deepStrictEqual(missing, [],
    `remediation would queue unrunnable jobs and report success: ${missing.join(', ')}`);
});
