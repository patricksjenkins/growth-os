/**
 * Chief Financial Agent — the operating runtime for Finance & Data Governance.
 *
 * Codex audit 2026-07-26: "control schema built; operating runtime absent."
 * The department had a mission, KPIs, supervised tables and accepted report
 * types — and no agent. Nothing watched while production sat on a Stripe
 * sandbox for two months, $775 of revenue never landed, Mercury stopped
 * importing, and the books drifted $2,415 from the bank.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const HEAD = read('worker', 'agents', 'finance-head.js');
const HEALTH = read('api', 'routes', 'admin-provider-health.js');
const { authorityVerdict } = require('../core/finance/reconciliation');

/* ── Authority verdict: strict by design ── */

test('books are authoritative only when identity, flow AND reconciliation all hold', () => {
  const good = authorityVerdict({
    providerHealth: { stripe: { ok: true }, webhook: { ok: true }, linkage: { ok: true } },
    reconciliation: { reconciled: true, variance: 0 },
    freshness: [{ provider: 'stripe', state: 'fresh' }],
  });
  assert.strictEqual(good.authoritative, true);
  assert.strictEqual(good.level, 'authoritative');
});

test('a sandbox connection can never be authoritative', () => {
  const v = authorityVerdict({
    providerHealth: {
      stripe: { ok: false, detail: 'Connected to a SANDBOX/TEST identity.' },
      webhook: { ok: true }, linkage: { ok: true },
    },
    reconciliation: { reconciled: true, variance: 0 },
    freshness: [],
  });
  assert.strictEqual(v.authoritative, false);
  assert.match(v.problems[0], /SANDBOX/);
});

test('an unexplained cash variance downgrades the verdict', () => {
  const v = authorityVerdict({
    providerHealth: { stripe: { ok: true }, webhook: { ok: true }, linkage: { ok: true } },
    reconciliation: { reconciled: false, variance: -1663.42 },
    freshness: [],
  });
  assert.strictEqual(v.authoritative, false);
  assert.match(v.problems.join(' '), /differ by \$1663\.42/);
});

test('a feed that never delivered is distinct from one that is merely late', () => {
  const v = authorityVerdict({
    providerHealth: { stripe: { ok: true }, webhook: { ok: true }, linkage: { ok: true } },
    reconciliation: { reconciled: true, variance: 0 },
    freshness: [
      { provider: 'stripe', state: 'never', hours_since: null },
      { provider: 'mercury', state: 'stale', hours_since: 105 },
    ],
  });
  assert.match(v.problems.join(' '), /stripe has never delivered/);
  assert.match(v.problems.join(' '), /mercury last delivered 4d ago/);
});

/* ── THE detector's own false green ── */

test('hand-backfilled rows do NOT count as proof the webhook works', () => {
  // This bug was in the detector itself: it accepted any row carrying a
  // stripe_invoice_id, so entries typed in from the Stripe dashboard on
  // 2026-07-26 read as webhook successes. It also compared source to
  // 'stripe_webhook' while the writer emits 'stripe-webhook'.
  assert.match(HEALTH, /source === 'stripe-webhook'/,
    'must match the string finance-sync actually writes');
  assert.ok(!/m\.stripe_invoice_id \|\| m\.stripe_charge_id \|\| m\.source/.test(HEALTH),
    'presence of a provider id must not imply the webhook wrote the row');
});

/* ── Safety envelope ── */

test('the Finance Head never writes to the ledger', () => {
  assert.ok(!/from\('finance_entries'\)[\s\S]{0,120}\.(insert|update|delete)\(/.test(HEAD),
    'the head reports and escalates; it has no authority over money');
  // Look for money-MOVING calls, not the substring "stripe" — the agent
  // legitimately reads a `stripe` health object. Precision matters here: a
  // test that fires on a variable name is a test nobody trusts.
  const code = HEAD.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const forbidden of [
    /stripe\.(charges|refunds|paymentIntents|transfers|payouts|subscriptions)\./,
    /require\(['"]stripe['"]\)/,
    /\.refund\(/, /\.capture\(/, /\.cancel\(/,
  ]) {
    assert.ok(!forbidden.test(code), `the head must not move money: matched ${forbidden}`);
  }
});

test('one finding per condition, updated and auto-resolved', () => {
  assert.match(HEAD, /finding_key/, 'findings are keyed per condition');
  assert.match(HEAD, /resolveFindings/, 'cleared conditions must close, not linger');
  assert.match(HEAD, /auto_resolved/);
});

test('FGA-scoped with a kill switch', () => {
  assert.match(HEAD, /not_fga_tenant/);
  assert.match(HEAD, /finance_head_enabled/);
  const writes = [...HEAD.matchAll(/tenant_id: ([A-Za-z_.]+)/g)].map((m) => m[1]);
  for (const t of writes) assert.strictEqual(t, 'FGA_TENANT_ID', `unscoped write: ${t}`);
});

test('unmet authority is declared a business failure, not a clean run', () => {
  assert.match(HEAD, /business_outcome_state: verdict\.authoritative \? 'achieved' : 'not_achieved'/,
    'a healthy-looking run with untrustworthy books is exactly the false green this fixes');
});

test('close readiness reports blockers rather than closing the month', () => {
  assert.match(HEAD, /closeReadiness/);
  assert.match(HEAD, /pending_expense_drafts/);
  assert.ok(!/close_month|post_close|finalize/i.test(HEAD), 'preparation only — the owner closes');
});

test('the head is registered and scheduled', () => {
  const server = read('api', 'server.js');
  const cron = read('worker', 'scheduler', 'cron.js');
  assert.match(server, /\['finance-head', '\.\.\/worker\/agents\/finance-head'\]/,
    'an unregistered agent fails with "Unknown agent" — the revenue-guardian lesson');
  assert.match(cron, /agent: 'finance-head'/);
});
