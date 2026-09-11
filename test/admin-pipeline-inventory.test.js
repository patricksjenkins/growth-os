'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'api', 'routes', 'admin.js'), 'utf8');
const start = source.indexOf("router.get('/pipeline'");
const end = source.indexOf("router.post('/pipeline'", start);
const route = source.slice(start, end);

test('the FGA Pipeline returns the full ordered inventory instead of a silent first page', () => {
  assert.ok(start > 0 && end > start, 'pipeline route source must be discoverable');
  assert.ok((route.match(/fetchAllRows/g) || []).length >= 4,
    'leads, sequences, autonomous ownership, and Facebook conversations must all page');
  assert.doesNotMatch(route, /\.limit\(5000\)/,
    'an oversized limit is still silently capped by PostgREST');
  assert.ok((route.match(/\.range\(from, to\)/g) || []).length >= 4);
});

test('Pipeline rows distinguish autonomous work and synthetic evidence from Patrick work', () => {
  assert.match(route, /growth_restart_candidates/);
  assert.match(route, /autonomous_authorized:/);
  assert.match(route, /is_synthetic_growth:/);
  assert.match(route, /intake_contact_allowed:metadata->intake_safety->>contact_allowed/);
});

test('every pipeline inventory failure is explicit rather than an empty partial view', () => {
  assert.ok((route.match(/\.error \|\| [a-zA-Z]+Result\.truncated/g) || []).length >= 4);
  assert.doesNotMatch(route, /pipeline sequences fetch failed/);
  assert.doesNotMatch(route, /pipeline fb conversations fetch failed/);
});
