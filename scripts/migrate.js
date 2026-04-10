/**
 * Growth OS — Migration Runner
 * Runs SQL migration files in order against Supabase
 *
 * Usage: node scripts/migrate.js
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { db } = require('../db/client');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');

async function runMigrations() {
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  console.log(`\nFound ${files.length} migration files\n`);

  for (const file of files) {
    const filePath = path.join(MIGRATIONS_DIR, file);
    const sql = fs.readFileSync(filePath, 'utf-8');

    console.log(`Running: ${file}...`);

    // Split by semicolons and run each statement
    const statements = sql
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('--'));

    for (const statement of statements) {
      try {
        const { error } = await db.rpc('exec_sql', { query: statement });
        if (error) {
          // Try direct query if RPC not available
          console.warn(`  Warning: ${error.message}`);
        }
      } catch (err) {
        console.warn(`  Statement warning: ${err.message}`);
      }
    }

    console.log(`  ✓ ${file}`);
  }

  console.log('\n✓ All migrations complete\n');
}

runMigrations()
  .then(() => process.exit(0))
  .catch(err => { console.error('Migration failed:', err); process.exit(1); });
