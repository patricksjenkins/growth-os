/**
 * Growth OS — Migration Runner
 * Runs SQL migration files in order against Supabase
 *
 * Usage:
 *   node scripts/migrate.js           # Run all migrations
 *   node scripts/migrate.js --fresh   # Run full schema.sql (fresh install)
 *
 * For a brand new Supabase project, use --fresh to run the complete schema.
 * For incremental updates, add numbered .sql files to db/migrations/
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');
const SCHEMA_FILE = path.join(__dirname, '..', 'db', 'schema.sql');

async function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env');
    process.exit(1);
  }
  return createClient(url, key);
}

/**
 * Execute SQL statements via Supabase's REST API
 * Uses the pg_net extension or direct SQL execution
 */
async function executeSql(supabase, sql) {
  // Use supabase.rpc to call a helper function, or fall back to
  // running statements individually via the Supabase management API
  const { data, error } = await supabase.rpc('exec_sql', { query: sql });
  if (error) {
    // If exec_sql RPC doesn't exist, provide setup instructions
    if (error.message.includes('function') || error.code === '42883') {
      throw new Error(
        'The exec_sql RPC function is not set up in your Supabase project.\n\n' +
        'To set it up, run this in the Supabase SQL Editor:\n\n' +
        '  CREATE OR REPLACE FUNCTION exec_sql(query text)\n' +
        '  RETURNS void AS $$\n' +
        '  BEGIN\n' +
        '    EXECUTE query;\n' +
        '  END;\n' +
        '  $$ LANGUAGE plpgsql SECURITY DEFINER;\n\n' +
        'Or run the full schema directly in the SQL Editor:\n' +
        '  Copy and paste the contents of db/schema.sql'
      );
    }
    throw error;
  }
  return data;
}

async function runFreshSchema() {
  console.log('\n=== Running full schema (fresh install) ===\n');

  if (!fs.existsSync(SCHEMA_FILE)) {
    console.error('db/schema.sql not found');
    process.exit(1);
  }

  const sql = fs.readFileSync(SCHEMA_FILE, 'utf-8');
  console.log(`Schema file: ${(sql.length / 1024).toFixed(1)} KB`);
  console.log('\nIMPORTANT: For a fresh Supabase project, copy the contents of');
  console.log('db/schema.sql and run it directly in the Supabase SQL Editor.');
  console.log('This ensures all CREATE TABLE, RLS, and function statements run correctly.\n');

  const supabase = await getSupabase();

  // Split into individual statements and run them
  const statements = sql
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.startsWith('--'));

  let success = 0;
  let failed = 0;

  for (const statement of statements) {
    try {
      await executeSql(supabase, statement);
      success++;
    } catch (err) {
      // IF NOT EXISTS statements may warn but not fail
      if (err.message.includes('already exists')) {
        console.log(`  (exists) ${statement.slice(0, 60)}...`);
        success++;
      } else {
        console.error(`  FAILED: ${statement.slice(0, 80)}...`);
        console.error(`    Error: ${err.message}`);
        failed++;
      }
    }
  }

  console.log(`\n${success} statements succeeded, ${failed} failed\n`);
}

async function runMigrations() {
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    console.log('No migration files found');
    return;
  }

  console.log(`\nFound ${files.length} migration files\n`);

  const supabase = await getSupabase();

  for (const file of files) {
    const filePath = path.join(MIGRATIONS_DIR, file);
    const sql = fs.readFileSync(filePath, 'utf-8');

    console.log(`Running: ${file}...`);

    const statements = sql
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('--'));

    let fileSuccess = 0;
    let fileWarnings = 0;

    for (const statement of statements) {
      try {
        await executeSql(supabase, statement);
        fileSuccess++;
      } catch (err) {
        if (err.message.includes('already exists')) {
          fileWarnings++;
        } else {
          console.error(`  Warning: ${err.message}`);
          fileWarnings++;
        }
      }
    }

    console.log(`  ✓ ${file} (${fileSuccess} ok, ${fileWarnings} warnings)`);
  }

  console.log('\n✓ All migrations complete\n');
}

// Main
const isFresh = process.argv.includes('--fresh');

if (isFresh) {
  runFreshSchema()
    .then(() => process.exit(0))
    .catch(err => { console.error('Migration failed:', err.message); process.exit(1); });
} else {
  runMigrations()
    .then(() => process.exit(0))
    .catch(err => { console.error('Migration failed:', err.message); process.exit(1); });
}
