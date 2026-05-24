/**
 * One-shot script to apply migrations 032 + 033 (security advisor fixes).
 *
 * Why a dedicated script instead of running scripts/migrate.js:
 *   - These are reversible defensive changes (RLS + EXECUTE revokes +
 *     ALTER FUNCTION ... SET search_path); we want explicit control + a
 *     single confirmation pass without re-running the whole migration set.
 *   - The standard runner has historically had issues with dollar-quoted
 *     plpgsql blocks; these two files use only ALTER/REVOKE/CREATE POLICY
 *     so they apply as a single SQL block.
 *
 * Usage:  node scripts/apply-security-fixes.js
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const MIGRATIONS = [
  path.join(__dirname, '..', 'db', 'migrations', '032_rls_missing_tables.sql'),
  path.join(__dirname, '..', 'db', 'migrations', '033_security_advisor_fixes.sql'),
];

async function run() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env');
    process.exit(1);
  }
  const supabase = createClient(url, key);

  for (const file of MIGRATIONS) {
    const name = path.basename(file);
    console.log(`\n[apply] ${name}`);
    const sql = fs.readFileSync(file, 'utf8');
    const { error } = await supabase.rpc('exec_sql', { query: sql });
    if (error) {
      console.error(`  FAILED: ${error.message}`);
      console.error(`  Code: ${error.code || 'n/a'}`);
      console.error(`  Hint: ${error.hint || 'none'}`);
      process.exit(1);
    }
    console.log(`  OK`);
  }

  console.log('\nBoth migrations applied successfully.');
  console.log('Re-run the Supabase Security Advisor linter to confirm the warnings cleared.');
}

run().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
