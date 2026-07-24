'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const migration = fs.readFileSync(
  path.join(root, 'db', 'migrations', '071_referral_tenant_integrity.sql'),
  'utf8'
);
const route = fs.readFileSync(
  path.join(root, 'api', 'routes', 'leads-capture.js'),
  'utf8'
);

test('public lead capture validates referral ownership before every insert', () => {
  assert.match(route, /if \(isValidUuid\(referrerLeadId\)\) \{/);
  assert.doesNotMatch(
    route,
    /if \(flags\.signedLeadCapture\(\) && isValidUuid\(referrerLeadId\)\)/
  );
  assert.match(route, /\.eq\('tenant_id', tenant_id\)[\s\S]{0,120}\.eq\('id', referrerLeadId\)/);
});

test('database guard rejects both referrer and referee tenant mismatches', () => {
  assert.match(migration, /referral_credits_tenant_guard/i);
  assert.match(migration, /id = NEW\.referrer_lead_id AND tenant_id = NEW\.tenant_id/i);
  assert.match(migration, /id = NEW\.referee_lead_id AND tenant_id = NEW\.tenant_id/i);
  assert.match(migration, /refusing to install integrity guard/i);
  assert.match(migration, /SECURITY DEFINER SET search_path = public, pg_temp/i);
});
