/**
 * Chief Revenue Agent — watchdog, bounded self-heal, incident model.
 *
 * Pass 3 adversarial scenarios from the CEO brief live here. The question
 * every test asks is the one the department kept failing: when something
 * stops the pipeline, does the system either recover safely or produce a
 * clear, actionable escalation — or does it go quiet again?
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const guardian = require('../worker/agents/revenue-guardian');
const { planRemediation, REMEDIATIONS, MAX_ATTEMPTS_PER_DAY, COOLDOWN_MINUTES } = guardian;
const { HEALTH } = require('../core/revenue/daily-outcome');
const { classifyReason, primaryBlocker } = require('../core/revenue/funnel-trace');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'worker', 'agents', 'revenue-guardian.js'), 'utf8');

/* ── Remediation planning: the right fix for the right failure ── */

test('low inventory with unscored leads triggers rescoring first', () => {
  const trace = { inventory: { scored: 10, withEmail: 500 } };
  assert.deepStrictEqual(planRemediation(HEALTH.DEGRADED_INVENTORY, trace, null),
    ['rescore_leads', 'replenish_inventory']);
});

test('low inventory with scored leads but no drafts regenerates drafts', () => {
  const trace = { inventory: { scored: 500, withEmail: 500 } };
  assert.deepStrictEqual(planRemediation(HEALTH.DEGRADED_INVENTORY, trace, null),
    ['regenerate_drafts', 'replenish_inventory']);
});

test('THE INCIDENT: a deliverability pause with bad addresses suppresses them', () => {
  const plan = planRemediation(HEALTH.BLOCKED_DELIVERABILITY, {},
    { suppressCandidates: ['dead@example.com'] });
  assert.deepStrictEqual(plan, ['suppress_bounced'],
    'one stale address must be removed and replaced, not allowed to stop the department');
});

test('a deliverability pause with NO removable cause escalates instead of guessing', () => {
  const plan = planRemediation(HEALTH.BLOCKED_DELIVERABILITY, {}, { suppressCandidates: [] });
  assert.deepStrictEqual(plan, [],
    'a genuine domain problem is not something the guardian may paper over');
});

test('behind pace with a clear funnel re-runs the CAPPED sender', () => {
  assert.deepStrictEqual(planRemediation(HEALTH.BEHIND_TARGET, {}, null), ['run_sender']);
});

test('configuration and provider failures are Tier 2/3 — never auto-fixed', () => {
  assert.deepStrictEqual(planRemediation(HEALTH.BLOCKED_CONFIGURATION, {}, null), []);
  assert.deepStrictEqual(planRemediation(HEALTH.BLOCKED_PROVIDER, {}, null), []);
});

test('healthy states never trigger remediation', () => {
  for (const h of [HEALTH.HEALTHY_ON_TARGET, HEALTH.HEALTHY_IN_PROGRESS, HEALTH.NOT_A_BUSINESS_DAY]) {
    assert.deepStrictEqual(planRemediation(h, {}, null), [], `${h} must be left alone`);
  }
});

/* ── Safety envelope ── */

test('the guardian NEVER sends email itself — it re-enqueues the capped sender', () => {
  assert.ok(!/sendEmail|sendTemplateEmail|resend\.|providerSend/i.test(SRC),
    'a watchdog that can send is a watchdog that can spam');
  assert.match(SRC, /agent_name: 'auto-outreach'/,
    'recovery must go through the existing gated sender');
});

test('remediation is bounded: attempts, cooldown, idempotency, kill switch', () => {
  assert.ok(MAX_ATTEMPTS_PER_DAY > 0 && MAX_ATTEMPTS_PER_DAY <= 6,
    `attempt cap must be small, got ${MAX_ATTEMPTS_PER_DAY}`);
  assert.ok(COOLDOWN_MINUTES >= 15, 'cooldown must prevent tight retry loops');
  assert.match(SRC, /attemptCount < MAX_ATTEMPTS_PER_DAY/, 'attempts must be enforced');
  assert.match(SRC, /cooledDown/, 'cooldown must be enforced');
  assert.match(SRC, /idempotency_key/, 'one incident per condition per day');
  assert.match(SRC, /revenue_guardian_enabled/, 'kill switch must exist');
});

test('the guardian cannot recurse into itself', () => {
  const enqueued = [...SRC.matchAll(/agent_name: '([a-z-]+)'/g)].map((m) => m[1]);
  assert.ok(!enqueued.includes('revenue-guardian'),
    'self-enqueue would create an uncontrolled agent loop');
});

test('FGA scope is enforced before any work', () => {
  assert.match(SRC, /isFga/, 'must check tenant identity');
  assert.match(SRC, /not_fga_tenant/, 'must exit early for client tenants');
  const enqueues = [...SRC.matchAll(/tenant_id: ([A-Za-z_.]+)/g)].map((m) => m[1]);
  for (const t of enqueues) {
    assert.strictEqual(t, 'FGA_TENANT_ID',
      `every write must be FGA-scoped, found tenant_id: ${t}`);
  }
});

test('remediations only touch safe, reversible surfaces', () => {
  // No money, no suppression *removal*, no config rewrites, no deletes.
  assert.ok(!/\.delete\(/.test(SRC), 'must never delete records');
  assert.ok(!/stripe|charge|refund|payment/i.test(SRC), 'must never touch money');
  assert.ok(!/tenant_config/.test(SRC), 'must not rewrite production configuration');
  const actions = Object.keys(REMEDIATIONS);
  assert.deepStrictEqual(actions.sort(), [
    'regenerate_drafts', 'replenish_inventory', 'rescore_leads', 'run_sender', 'suppress_bounced',
  ], 'the Tier-1 set must stay small and reviewable');
});

/* ── Incident model ── */

test('one condition produces ONE incident, updated — not a daily alert', () => {
  assert.match(SRC, /const key = `revenue-outcome:\$\{etDate\}:\$\{health\}`/,
    'idempotency key must be per day AND per condition');
  assert.match(SRC, /if \(match\) \{/, 'an existing incident must be updated, not duplicated');
  assert.match(SRC, /is\('resolved_at', null\)/, 'only open incidents are matched');
});

test('incidents auto-resolve when the target is met', () => {
  assert.match(SRC, /resolveIncidents/, 'must close incidents on success');
  assert.match(SRC, /counted\.count >= target \? await resolveIncidents/,
    'resolution is gated on actually hitting the target');
});

test('exhausted remediation escalates to the owner rather than going quiet', () => {
  assert.match(SRC, /humanActionRequired = true/);
  assert.match(SRC, /HEALTH\.HUMAN_ACTION_REQUIRED/);
});

/* ── Funnel classification: correct exclusions are not failures ── */

test('terminal gate reasons are not department failures', () => {
  for (const r of ['suppression', 'dedupe', 'not_customer', 'blocklist', 'inbound_lead', 'icp_fit']) {
    assert.strictEqual(classifyReason(r), 'terminal',
      `${r} is correct behaviour and must not raise an incident`);
  }
});

test('recoverable gate reasons map to actionable blocker classes', () => {
  assert.strictEqual(classifyReason('deliverability'), 'deliverability');
  assert.strictEqual(classifyReason('kill_switch'), 'configuration');
  assert.strictEqual(classifyReason('draft_quality'), 'quality');
  assert.strictEqual(classifyReason('daily_cap'), 'capacity');
});

test('primaryBlocker ranks deliverability above quality', () => {
  const trace = { blockers: { quality: 'q', deliverability: 'd' } };
  assert.strictEqual(primaryBlocker(trace).class, 'deliverability');
  assert.strictEqual(primaryBlocker({ blockers: {} }), null);
});

/* ── Agent contract ── */

test('the guardian declares an outcome contract on every path', () => {
  const contracts = (SRC.match(/outcome_contract:/g) || []).length;
  assert.ok(contracts >= 4,
    `every return path must declare its outcome, found ${contracts}`);
  assert.match(SRC, /business_outcome_state: 'not_achieved'/,
    'a missed target must declare business failure, not silent success');
});

test('a non-FGA tenant is a no-op, not an error', async () => {
  const r = await guardian({ id: 'other-tenant', slug: 'client-x', config: {} }, {});
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.skipped, 'not_fga_tenant');
});

test('the kill switch stops the guardian cleanly', async () => {
  const r = await guardian(
    { id: '30566ed6-026a-45e1-9502-029e6219df31', slug: 'fga',
      config: { revenue_guardian_enabled: 'false' } }, {});
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.skipped, 'kill_switch');
});

test('checkpoints are scheduled across the business day', () => {
  const cron = fs.readFileSync(path.join(__dirname, '..', 'worker', 'scheduler', 'cron.js'), 'utf8');
  const entries = (cron.match(/agent: 'revenue-guardian'/g) || []).length;
  assert.strictEqual(entries, 5, 'five checkpoints: 08:00, 10:30, 13:30, 15:30, 17:00');
  assert.ok(/revenue-guardian[\s\S]{0,200}isFGAlike/.test(cron),
    'checkpoints must be FGA-only');
});
