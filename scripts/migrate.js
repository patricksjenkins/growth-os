/**
 * Growth OS — Migration Runner
 * Produces a deterministic forward-migration plan.
 *
 * Usage:
 * Execution was intentionally removed because the legacy implementation split
 * procedural SQL on semicolons, had no checksum ledger, and continued after
 * failures. A transactional, reviewed runner will replace it.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');

function listForwardMigrations(migrationsDir = MIGRATIONS_DIR) {
  return fs.readdirSync(migrationsDir)
    .filter(file => file.endsWith('.sql'))
    // Rollbacks are operator-invoked recovery artifacts. They must never be
    // included in the normal forward migration path.
    .filter(file => !file.endsWith('_rollback.sql'))
    .sort();
}

function assertLegacyExecutionExplicitlyEnabled() {
  throw new Error(
    'Migration execution is disabled: the unsafe legacy executor was removed. ' +
    'Use the plan output and the reviewed transactional production activation process.'
  );
}

function printMigrationPlan() {
  const files = listForwardMigrations();
  console.log(JSON.stringify({
    mode: 'plan_only',
    execution_enabled: false,
    migration_count: files.length,
    files,
    warning: 'No SQL was executed. Production migrations require the consolidated approval process.',
  }, null, 2));
}

if (require.main === module) {
  const execute = process.argv.includes('--execute');

  if (execute || process.argv.includes('--fresh')) {
    try {
      assertLegacyExecutionExplicitlyEnabled();
    } catch (error) {
      console.error(error.message);
      process.exit(1);
    }
  }

  printMigrationPlan();
}

module.exports = {
  listForwardMigrations,
  printMigrationPlan,
  assertLegacyExecutionExplicitlyEnabled,
};
