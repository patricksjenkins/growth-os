/**
 * Stripe revenue must land in FGA's book of record.
 *
 * Codex audit 2026-07-26, verified in code: finance-sync inserted income with
 * `tenant_id: tenantId` — the CLIENT's tenant — while Reports & Insights reads
 * only FGA_TENANT_ID. Every webhook-booked dollar was invisible in the P&L by
 * construction, and simultaneously inflated the client's own books. No test
 * covered which ledger the money landed in.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'integrations', 'finance-sync.js'), 'utf8');
const READER = fs.readFileSync(path.join(__dirname, '..', 'api', 'routes', 'admin.js'), 'utf8');

test('income is booked to FGA, never to the paying client', () => {
  assert.match(SRC, /const bookTenantId = FGA_TENANT_ID/,
    'the book of record must be FGA');
  const incomeInsert = SRC.slice(SRC.indexOf("entry_type: 'income'") - 400, SRC.indexOf("entry_type: 'income'") + 200);
  assert.ok(!/tenant_id: tenantId\b/.test(incomeInsert),
    'THE BUG: income must not be inserted under the client tenant');
  assert.match(incomeInsert, /tenant_id: bookTenantId/);
});

test('the client is still attributed, so per-client revenue stays reportable', () => {
  assert.match(SRC, /customer_tenant_id: tenantId/,
    'the paying client must be recorded as attribution metadata');
  assert.match(SRC, /customer_name: clientName/);
});

test('the ledger written matches the ledger read', () => {
  // finance-sync writes FGA_TENANT_ID; the reports route must read the same.
  assert.match(READER, /\.eq\('tenant_id', FGA_TENANT_ID\)/,
    'Reports reads FGA ledger — writer and reader must agree');
});

test('every bare FGA_TENANT_ID use is actually imported', () => {
  // Regression: FGA_TENANT_ID was referenced without an import. require()
  // succeeded because the use is inside a function; it would have thrown
  // ReferenceError on the first real payment — silently, inside a webhook
  // that returns 200 on failure, losing the event permanently.
  const bareUses = [...SRC.matchAll(/(?<![.\w])FGA_TENANT_ID/g)].length;
  if (bareUses > 0) {
    assert.match(SRC, /const \{[^}]*FGA_TENANT_ID[^}]*\} = require\(/,
      `FGA_TENANT_ID used ${bareUses}× but never imported`);
  }
});

test('provider health endpoint exists and never leaks a key', () => {
  const ph = fs.readFileSync(path.join(__dirname, '..', 'api', 'routes', 'admin-provider-health.js'), 'utf8');
  assert.match(ph, /api\.stripe\.com\/v1\/account/, 'must resolve the real account identity');
  assert.match(ph, /SANDBOX/, 'must be able to name a sandbox connection as the fault it is');
  assert.ok(!/res\.json\([^)]*STRIPE_SECRET_KEY/.test(ph), 'must never return the key');
  const server = fs.readFileSync(path.join(__dirname, '..', 'api', 'server.js'), 'utf8');
  assert.match(server, /provider-health/, 'route must be mounted');
});
