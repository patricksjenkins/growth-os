'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(
  path.join(
    __dirname,
    '..',
    'db',
    'migrations',
    '093_autonomous_digest_resolution.sql',
  ),
  'utf8',
);
const rollback = fs.readFileSync(
  path.join(
    __dirname,
    '..',
    'db',
    'rollbacks',
    '093_autonomous_digest_resolution_rollback.sql',
  ),
  'utf8',
);

test('managed Supabase digest resolution is additive and authority-neutral', () => {
  assert.match(
    migration,
    /SET search_path TO pg_catalog, public, extensions/,
  );
  assert.match(migration, /pg_get_function_identity_arguments/);
  assert.match(migration, /pg_get_functiondef/);
  assert.doesNotMatch(migration, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
  assert.doesNotMatch(migration, /\bGRANT\b/i);
  assert.doesNotMatch(migration, /\bDROP\b/i);
});

test('digest resolution covers every supervised executive function family', () => {
  for (const prefix of [
    'reliability_head_',
    'revenue_head_',
    'cos_',
    'chief_of_staff_',
    'onboarding_head_',
    'onboarding_customer_outcome_',
    'client_success_head_',
    'finance_governance_',
    'marketing_brand_',
    'product_engineering_',
  ]) {
    assert.match(migration, new RegExp(prefix));
  }
});

test('rollback restores the original pinned path without deleting evidence', () => {
  assert.match(rollback, /SET search_path TO pg_catalog, public/);
  assert.doesNotMatch(rollback, /\b(?:DELETE|TRUNCATE|DROP)\b/i);
});
