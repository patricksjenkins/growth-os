'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  listForwardMigrations,
  assertLegacyExecutionExplicitlyEnabled,
} = require('../scripts/migrate');

test('normal migration runs never execute rollback artifacts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fga-migrations-'));
  try {
    fs.writeFileSync(path.join(dir, '001_start.sql'), 'select 1;');
    fs.writeFileSync(path.join(dir, '002_change.sql'), 'select 2;');
    fs.writeFileSync(path.join(dir, '002_change_rollback.sql'), 'drop table danger;');
    fs.writeFileSync(path.join(dir, 'README.md'), 'not a migration');

    assert.deepEqual(listForwardMigrations(dir), [
      '001_start.sql',
      '002_change.sql',
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('legacy migration execution cannot be re-enabled by an environment override', () => {
  const previous = process.env.ALLOW_UNSAFE_LEGACY_MIGRATION_RUNNER;
  process.env.ALLOW_UNSAFE_LEGACY_MIGRATION_RUNNER = 'true';
  try {
    assert.throws(
      () => assertLegacyExecutionExplicitlyEnabled(),
      /unsafe legacy executor was removed/
    );
  } finally {
    if (previous === undefined) delete process.env.ALLOW_UNSAFE_LEGACY_MIGRATION_RUNNER;
    else process.env.ALLOW_UNSAFE_LEGACY_MIGRATION_RUNNER = previous;
  }
});
