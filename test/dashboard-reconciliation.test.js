/**
 * Dashboard reconciliation invariants (2026-07-22).
 *
 * The admin dashboard had 13 number-vs-click-through mismatches with three
 * root causes, each pinned here so it cannot quietly regress:
 *
 *  1. UNBOUNDED SELECTS: PostgREST silently caps un-limited selects at 1000
 *     rows. The agent banner pulled 30 days of jobs (~5k rows) unbounded,
 *     got the OLDEST 1000, and reported "0 ACTIVE / 31 SETUP REQUIRED"
 *     while 30 agents had completed within 24h. Every aggregate pull in
 *     dashboard-summary must now carry an explicit .limit().
 *  2. WINDOW LIES: "Leads Captured (30d)" / "Content Created (30d)" had no
 *     date filter at all.
 *  3. SCOPE MIXING: cross-tenant counters/feeds linked into FGA-scoped
 *     inboxes (the "Web chat started · 923A Coins → empty inbox" bug).
 *     Patrick's rule: the dashboard runs FGA's business; client-tenant
 *     activity lives in a separate labeled section with tenant-aware links.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const adminSrc = fs.readFileSync(path.join(__dirname, '..', 'api', 'routes', 'admin.js'), 'utf8');

function section(startMarker, endMarker) {
  const start = adminSrc.indexOf(startMarker);
  assert.ok(start !== -1, `marker not found: ${startMarker}`);
  const end = endMarker ? adminSrc.indexOf(endMarker, start) : start + 20000;
  return adminSrc.slice(start, end === -1 ? start + 20000 : end);
}

test('dashboard-summary aggregate pulls are date-scoped AND explicitly limited', () => {
  const block = section("'/dashboard-summary'", "'/activity-feed'");
  // The four client-scope pulls: leads, content_drafts, agent_jobs, conversations.
  const pulls = block.match(/\.in\('tenant_id', tenantIds\)[\s\S]{0,400}?(?=Promise\.resolve|\])/g) || [];
  assert.ok(pulls.length >= 4, `expected >=4 tenant-scoped pulls, found ${pulls.length}`);
  for (const p of pulls) {
    assert.match(p, /gte\('created_at', since30d\)/, `pull missing 30d window: ${p.slice(0, 80)}`);
    assert.match(p, /\.limit\(\d+\)/, `pull missing explicit limit: ${p.slice(0, 80)}`);
  }
});

test('agent fleet health: cross-tenant, 7d roster, bounded, no setup_required', () => {
  const block = section('----- AGENTS', '----- FAILED AUTOMATIONS');
  assert.match(block, /since7dIso/, '7-day roster window');
  assert.match(block, /\.order\('created_at', \{ ascending: false \}\)/, 'newest-first — truncation must drop OLD rows, not new ones');
  assert.match(block, /\.limit\(\d{4}\)/, 'explicit limit');
  assert.ok(!/\.eq\('tenant_id', FGA_TENANT_ID\)/.test(block),
    'fleet health is cross-tenant (matches the Agent Hub the banner links to)');
  assert.ok(!/health = 'setup_required'/.test(block),
    '"setup required" implied missing configuration; the vocabulary is active/on_watch/idle');
  assert.match(block, /health = 'idle'/);
});

test('web-chats inbox: FGA default, explicit single-tenant drilldown, NO all-tenants mode', () => {
  const block = section("'/web-chats'", 'total_messages');
  // Command Center purpose directive: missing/ambiguous tenant NEVER widens
  // scope — the default is FGA. The only other mode is one explicit tenant.
  assert.match(block, /tenantParam && tenantParam !== 'all' \? tenantParam : FGA_TENANT_ID/,
    "'all' is rejected — it resolves to FGA, never to every tenant");
  assert.match(block, /\.eq\('tenant_id', scopeTenantId\)/, 'every query row is tenant-scoped');
  assert.match(block, /tenant_name/i, 'drilldown sessions carry their tenant label');
});

test('activity feed is FGA-only — client events never appear in any feed', () => {
  const block = section("'/activity-feed'", 'module.exports');
  // Command Center purpose directive (2026-07-22): the feed is Patrick's
  // business. No scope parameter, no cross-tenant branch — the approved
  // cross-tenant surface is the Information Center (counts only).
  assert.ok(!/req\.query\.scope/.test(block), 'no scope param — the feed cannot be widened by query string');
  assert.match(block, /const scoped = \(q\) => q\.eq\('tenant_id', FGA_TENANT_ID\)/, 'every pull is FGA-scoped');
  assert.ok(!/neq\('tenant_id'/.test(block), 'no inverted-scope (all-clients) branch remains');
});

test('info-center is counts/health only — no customer-content columns', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'routes', 'admin-info-center.js'), 'utf8');
  for (const forbidden of ['message_body', 'message_subject', 'company_name', 'first_name', 'last_name', "select('*')", 'email,']) {
    assert.ok(!src.includes(forbidden), `info-center must never select customer content: found "${forbidden}"`);
  }
  assert.match(src, /adminMiddleware|admin-info-center/, 'admin-only surface');
  assert.match(src, /\.in\('tenant_id', clientIds\)/, 'every activity query explicitly tenant-scoped');
  assert.ok(!/FGA_TENANT_ID\)\s*\.gte/.test(src), 'info-center never mixes FGA operations into the client summary');
});

test('failed-automations metric and the agent banner read the same bounded query', () => {
  const block = section('----- FAILED AUTOMATIONS', '----- LEADS / CONTENT');
  assert.match(block, /fleetJobs/, 'derived from the same fleet query as the banner');
});

test('client health thresholds agree between dashboard and clients page', () => {
  const summaryMatches = adminSrc.match(/days <= 21\) health = 'yellow'|daysSince <= 21\) health = 'yellow'|else if \(days(?:Since)? <= 21\)/g) || [];
  assert.ok(summaryMatches.length >= 2, 'both surfaces use the 21-day yellow threshold');
  assert.ok(!/daysSince <= 30\) health = 'yellow'/.test(adminSrc), 'the 30-day variant is gone');
});
