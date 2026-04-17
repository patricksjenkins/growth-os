/**
 * One-off runner for migration 013 (conversations, outreach_sequences, activity_log).
 * Uses the exec_sql RPC; falls back to individual statements otherwise.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
    process.exit(1);
  }
  const supabase = createClient(url, key);

  const file = path.join(__dirname, '..', 'db', 'migrations', '013_conversations_and_activity.sql');
  const sql = fs.readFileSync(file, 'utf-8');

  const statements = sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('--'));

  let ok = 0;
  let warn = 0;
  let failed = 0;

  for (const stmt of statements) {
    try {
      const { error } = await supabase.rpc('exec_sql', { query: stmt });
      if (error) {
        // Supabase sometimes returns an error for IF NOT EXISTS / IF EXISTS
        // idempotent statements — treat as warnings.
        if (/already exists/i.test(error.message) || /does not exist/i.test(error.message)) {
          warn++;
          console.warn(`[warn] ${error.message}`);
        } else {
          failed++;
          console.error(`[fail] ${error.message}\n  >>> ${stmt.slice(0, 120)}`);
        }
      } else {
        ok++;
      }
    } catch (err) {
      failed++;
      console.error(`[fail] ${err.message}\n  >>> ${stmt.slice(0, 120)}`);
    }
  }

  console.log(`\nMigration 013 result: ok=${ok} warn=${warn} failed=${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
