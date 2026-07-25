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

/**
 * Every agent name this file hands to the job queue, however it is written:
 * `agent_name: 'x'` for direct inserts, `queueJob(db, 'x', ...)` for the
 * checked helper. Extracting both is deliberate — an earlier version of these
 * tests matched only the literal form and went green when a refactor moved the
 * name into a helper argument, which is exactly how a grep-based test lies.
 */
function enqueuedAgents(src = SRC) {
  return [
    ...[...src.matchAll(/agent_name:\s*'([a-z0-9-]+)'/g)].map((m) => m[1]),
    ...[...src.matchAll(/queueJob\(\s*db\s*,\s*'([a-z0-9-]+)'/g)].map((m) => m[1]),
  ];
}

test('the guardian NEVER sends email itself — it re-enqueues the capped sender', () => {
  assert.ok(!/sendEmail|sendTemplateEmail|resend\.|providerSend/i.test(SRC),
    'a watchdog that can send is a watchdog that can spam');
  assert.ok(enqueuedAgents().includes('auto-outreach'),
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
  assert.ok(!enqueuedAgents().includes('revenue-guardian'),
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

/* ── False-green: a remediation that queues nothing must SAY so ──
 *
 * Codex review 2026-07-25: every queue path returned ok:true unconditionally,
 * so a failed insert produced "queued auto-outreach recovery run". These tests
 * drive the real functions against a failing client instead of grepping source.
 */

/** Minimal Supabase-shaped stub. `outcome` decides what insert().select() gives back. */
function stubDb(outcome) {
  return {
    from() {
      const builder = {
        insert: () => builder,
        select: () => Promise.resolve(outcome),
        eq: () => builder,
        limit: () => Promise.resolve({ data: [], error: null }),
      };
      return builder;
    },
  };
}

const DB_FAILS = stubDb({ data: null, error: { message: 'permission denied for table agent_jobs' } });
const DB_SILENT = stubDb({ data: [], error: null });
const DB_OK = stubDb({ data: [{ id: 'job-1' }], error: null });

test('a failed insert reports ok:false, not a queued recovery run', async () => {
  const r = await REMEDIATIONS.run_sender(DB_FAILS, {});
  assert.strictEqual(r.ok, false, 'THE false-green: this returned ok:true while queueing nothing');
  assert.match(r.detail, /permission denied/, 'the real cause must reach the incident');
});

test('an insert that silently returns no row is also a failure', async () => {
  const r = await REMEDIATIONS.run_sender(DB_SILENT, {});
  assert.strictEqual(r.ok, false, 'no row inserted means no job queued');
});

test('a successful insert still reports ok:true', async () => {
  const r = await REMEDIATIONS.run_sender(DB_OK, {});
  assert.strictEqual(r.ok, true);
  assert.match(r.detail, /queued auto-outreach/);
});

test('every queueing remediation propagates failure', async () => {
  for (const name of ['rescore_leads', 'regenerate_drafts', 'run_sender', 'replenish_inventory']) {
    const r = await REMEDIATIONS[name](DB_FAILS, {});
    assert.strictEqual(r.ok, false, `${name} must not claim success on a failed insert`);
  }
});

test('partial replenish failure is not success', async () => {
  // prospecting succeeds, enrichment fails -> the inventory problem is not being worked.
  let call = 0;
  const flaky = {
    from() {
      const b = {
        insert: () => b,
        select: () => Promise.resolve(call++ === 0
          ? { data: [{ id: 'a' }], error: null }
          : { data: null, error: { message: 'boom' } }),
      };
      return b;
    },
  };
  const r = await REMEDIATIONS.replenish_inventory(flaky, {});
  assert.strictEqual(r.ok, false, 'one of two queued is not a working replenish');
});

test('all-failed remediation escalates to human action', () => {
  assert.match(SRC, /remediations\.every\(\(r\) => !r\.ok\)/,
    'a plan that lands nothing must not read as handled');
  assert.match(SRC, /All \$\{remediations\.length\} remediation\(s\) failed/);
});
