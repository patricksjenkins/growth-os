'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(
  path.join(__dirname, '..', 'db', 'migrations', '108_chief_of_staff_reliability_period_alignment.sql'),
  'utf8',
);
const rollback = fs.readFileSync(
  path.join(__dirname, '..', 'db', 'rollbacks', '108_chief_of_staff_reliability_period_alignment_rollback.sql'),
  'utf8',
);
const applyScript = fs.readFileSync(
  path.join(__dirname, '..', 'scripts', 'apply-chief-of-staff-period-alignment.js'),
  'utf8',
);

test('migration aligns both exclusive Reliability bounds to the Eastern report day', () => {
  assert.match(migration, /period_start AT TIME ZONE 'America\/New_York'/);
  assert.match(migration, /period_end - interval '1 microsecond'/);
  assert.match(migration, /period_end[\s\S]+AT TIME ZONE 'America\/New_York'/);
  assert.match(migration, /cos_report_period_alignment_source_drift/);
  assert.match(migration, /v_occurrences <> 1/);
});

test('migration is code-only, idempotent, and carries no transaction wrapper', () => {
  assert.doesNotMatch(migration, /\b(INSERT|UPDATE|DELETE|TRUNCATE)\s+(INTO\s+)?public\./i);
  assert.doesNotMatch(migration, /^\s*(BEGIN|COMMIT)\s*;/mi);
  assert.match(migration, /IF v_occurrences = 0 AND position\(v_aligned IN v_definition\) > 0/);
  assert.match(applyScript, /--confirm-fga-production/);
  assert.match(applyScript, /authority_controls_changed: false/);
  assert.match(applyScript, /customer_rows_rewritten: false/);
});

test('rollback restores the exact migration-087 predicate without touching rows', () => {
  assert.match(rollback, /source_report\.period_start::date = p_reporting_period_start/);
  assert.match(rollback, /source_report\.period_end::date = p_reporting_period_end/);
  assert.match(rollback, /cos_report_period_alignment_rollback_source_drift/);
  assert.doesNotMatch(rollback, /\b(INSERT|UPDATE|DELETE|TRUNCATE)\s+(INTO\s+)?public\./i);
  assert.doesNotMatch(rollback, /^\s*(BEGIN|COMMIT)\s*;/mi);
});

