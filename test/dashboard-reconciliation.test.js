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

test('web-chats inbox: FGA default, per-tenant + all-tenants supported', () => {
  const block = section("'/web-chats'", 'total_messages');
  assert.match(block, /req\.query\.tenant/, 'tenant param exists');
  assert.match(block, /\.eq\('tenant_id', FGA_TENANT_ID\)/, 'default stays FGA — the dashboard counter matches this inbox');
  assert.match(block, /tenant_name/i, 'sessions carry a tenant label for the all-clients view');
});

test('activity feed: scope split with tenant-aware web-chat links', () => {
  const block = section("'/activity-feed'", 'module.exports');
  assert.match(block, /req\.query\.scope/, 'scope param exists');
  assert.match(block, /scope === 'fga'\s*\?\s*q\.eq\('tenant_id', FGA_TENANT_ID\)/, 'fga scope filters to the FGA tenant');
  assert.match(block, /\/admin\/web-chats\?tenant=\$\{c\.tenant_id\}/,
    'client web-chat items deep-link with the OWNING tenant (the 923A → empty-inbox bug)');
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
