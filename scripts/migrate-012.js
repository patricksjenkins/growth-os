/**
 * One-off runner for migration 012 (push_devices).
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

  const file = path.join(__dirname, '..', 'db', 'migrations', '012_push_devices.sql');
  const sql = fs.readFileSync(file, 'utf-8');

  const statements = sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('--'));

  let ok = 0;
  let warn = 0;
  let failed = 0;

  for (const stmt of statements) {
    const preview = stmt.replace(/\s+/g, ' ').slice(0, 80);
    try {
      const { error } = await supabase.rpc('exec_sql', { query: stmt });
      if (error) throw error;
      ok++;
      console.log(`  OK: ${preview}`);
    } catch (err) {
      const msg = err.message || String(err);
      if (msg.includes('already exists')) {
        warn++;
        console.log(`  skip (exists): ${preview}`);
      } else {
        failed++;
        console.error(`  FAIL: ${preview}`);
        console.error(`    ${msg}`);
      }
    }
  }

  console.log(`\nDone: ${ok} applied, ${warn} already existed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
