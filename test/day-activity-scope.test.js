/**
 * Day Activity scope guard (2026-07-24).
 *
 * This endpoint is the one admin surface that serves full MESSAGE BODIES
 * (so Patrick can read the exact email that went out). That makes tenant
 * scope a privacy boundary, not just a correctness one: a missing filter
 * here would put a client tenant's customer conversations on the FGA
 * dashboard — exactly what the Command Center purpose directive forbids.
 *
 * Every data query must be explicitly .eq('tenant_id', FGA_TENANT_ID) and
 * explicitly limited (PostgREST silently caps unbounded selects — see the
 * 2026-07-22 dashboard reconciliation).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'api', 'routes', 'admin-day-activity.js');
const src = fs.readFileSync(SRC, 'utf8');

test('every table read goes through the FGA tenant filter', () => {
  // The route funnels all reads through T(), which applies the tenant filter.
  assert.match(src, /const T = \(q\) => q\.eq\('tenant_id', FGA_TENANT_ID\)/,
    'the tenant-scoping helper must pin FGA_TENANT_ID');

  // Any .from('table') must be wrapped in T(...) — catch a raw read.
  const rawReads = [];
  const re = /(.{0,12})db\.from\('([a-z_]+)'\)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const preceding = m[1];
    if (!preceding.includes('T(')) rawReads.push(m[2]);
  }
  assert.deepStrictEqual(rawReads, [],
    `every db.from() must be wrapped in T() for tenant scoping. Unscoped: ${rawReads.join(', ')}`);
});

test('no cross-tenant escape hatch exists', () => {
  assert.ok(!/req\.query\.tenant/.test(src), 'no tenant override from the query string');
  assert.ok(!/neq\('tenant_id'/.test(src), 'no inverted-scope (other tenants) branch');
  assert.ok(!/'all'/.test(src), 'no all-tenants mode');
});

test('every query is explicitly limited', () => {
  const fromCount = (src.match(/db\.from\('/g) || []).length;
  const limitCount = (src.match(/\.limit\(/g) || []).length;
  assert.ok(limitCount >= fromCount,
    `every read needs an explicit .limit() (found ${fromCount} reads, ${limitCount} limits)`);
});

test('the day window is computed in ET and is exactly 24h', () => {
  assert.match(src, /America\/New_York/, 'day boundaries are ET, matching how Patrick reads his day');
  assert.match(src, /86400000/, 'window is exactly one day wide');
});

test('date input is validated (no injection into the range)', () => {
  assert.match(src, /\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\//,
    'the date param must be shape-validated before use');
});
