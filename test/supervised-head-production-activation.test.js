'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const activation = fs.readFileSync(
  path.join(
    __dirname,
    '..',
    'db',
    'operations',
    '20260724_activate_fga_supervised_heads.sql',
  ),
  'utf8',
);
const deactivation = fs.readFileSync(
  path.join(
    __dirname,
    '..',
    'db',
    'operations',
    '20260724_deactivate_fga_supervised_heads.sql',
  ),
  'utf8',
);

test('supervised activation is exact-FGA, transactional, and outreach-free', () => {
  assert.match(activation, /^BEGIN;/m);
  assert.match(activation, /^COMMIT;/m);
  assert.match(activation, /tenant\.slug = 'fga'/);
  assert.doesNotMatch(activation, /outreach_enabled\s*,?\s*true/i);
  assert.doesNotMatch(activation, /customer_communications?_enabled\s*,?\s*true/i);
  assert.doesNotMatch(activation, /provider_dispatch_enabled\s*,?\s*true/i);
  assert.doesNotMatch(activation, /production_write_(?:authority|enabled)\s*,?\s*true/i);
});

test('Chief of Staff remains dependency-gated during Department Head activation', () => {
  assert.match(
    activation,
    /v_tenant_id,\s*false,\s*'disabled',\s*true,\s*true,/,
  );
  assert.match(
    activation,
    /staged_pending_accepted_reliability_and_revenue_reports/,
  );
});

test('the FGA-only deactivation retains evidence and engages every kill switch', () => {
  assert.match(deactivation, /^BEGIN;/m);
  assert.match(deactivation, /^COMMIT;/m);
  assert.match(deactivation, /slug = 'fga'/);
  assert.equal(
    (deactivation.match(/kill_switch_engaged = true/g) || []).length,
    8,
  );
  assert.doesNotMatch(deactivation, /\bDELETE\b/i);
  assert.doesNotMatch(deactivation, /\bDROP\b/i);
  assert.doesNotMatch(deactivation, /\bTRUNCATE\b/i);
});
