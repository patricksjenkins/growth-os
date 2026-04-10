import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const scriptDir = typeof __dirname !== 'undefined'
  ? __dirname
  : path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(scriptDir, '..', '.env') });

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://fogmqtnvmwahkmngmkds.supabase.co',
  process.env.SUPABASE_SERVICE_KEY || 'SERVICE_KEY_HERE'
);

interface IncomeEntry {
  customer_name: string;
  amount: number;
  date: string;
  job_type: string;
}

interface ExpenseEntry {
  description: string;
  amount: number;
  category: string;
  date: string;
  is_recurring: boolean;
}

// Guess job type from customer name or context
function guessJobType(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('stump')) return 'stump_grinding';
  if (n.includes('firewood')) return 'other';
  if (n.includes('haul') || n.includes('debris')) return 'hauling';
  if (n.includes('trim') || n.includes('prune')) return 'tree_trimming';
  if (n.includes('clearing') || n.includes('lot')) return 'land_clearing';
  // Default mix based on tree service work
  return 'tree_removal';
}

async function main() {
  console.log('=== Seed from Real Spreadsheet Data ===\n');

  if (!process.env.SUPABASE_SERVICE_KEY) {
    console.error('ERROR: SUPABASE_SERVICE_KEY not found. Set it in .env');
    process.exit(1);
  }

  // Load extracted spreadsheet data
  const dataPath = path.resolve(scriptDir, 'spreadsheet-data.json');
  const raw = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

  const incomeRaw: { year: number; month: number; customer_name: string; amount: number }[] = raw.income;
  const expenseRaw: { year: number; month: number; description: string; amount: number; category: string }[] = raw.expenses;

  // Convert to DB format
  const incomeEntries: IncomeEntry[] = incomeRaw.map((e) => ({
    customer_name: e.customer_name,
    amount: e.amount,
    date: `${e.year}-${String(e.month).padStart(2, '0')}-15`,
    job_type: guessJobType(e.customer_name),
  }));

  const expenseEntries: ExpenseEntry[] = expenseRaw.map((e) => ({
    description: e.description,
    amount: e.amount,
    category: e.category,
    date: `${e.year}-${String(e.month).padStart(2, '0')}-15`,
    is_recurring: false,
  }));

  // Clear existing data
  console.log('Clearing existing data...');
  const tables = ['income_entries', 'expense_entries'];
  for (const table of tables) {
    const { error } = await supabase.from(table).delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (error) console.warn(`  Warning clearing ${table}: ${error.message}`);
    else console.log(`  Cleared ${table}`);
  }

  // Insert income in batches
  console.log(`\nInserting ${incomeEntries.length} income entries...`);
  const batchSize = 500;
  for (let i = 0; i < incomeEntries.length; i += batchSize) {
    const batch = incomeEntries.slice(i, i + batchSize);
    const { error } = await supabase.from('income_entries').insert(batch);
    if (error) {
      console.error(`  Error inserting income batch ${Math.floor(i / batchSize) + 1}:`, error.message);
    } else {
      console.log(`  Income batch ${Math.floor(i / batchSize) + 1}: ${batch.length} records`);
    }
  }

  // Insert expenses in batches
  console.log(`\nInserting ${expenseEntries.length} expense entries...`);
  for (let i = 0; i < expenseEntries.length; i += batchSize) {
    const batch = expenseEntries.slice(i, i + batchSize);
    const { error } = await supabase.from('expense_entries').insert(batch);
    if (error) {
      console.error(`  Error inserting expense batch ${Math.floor(i / batchSize) + 1}:`, error.message);
    } else {
      console.log(`  Expense batch ${Math.floor(i / batchSize) + 1}: ${batch.length} records`);
    }
  }

  // Summary by year
  console.log('\n=== Summary ===');
  const years = [2019, 2020, 2021, 2022, 2023, 2024, 2025];
  for (const y of years) {
    const yi = incomeRaw.filter((e) => e.year === y);
    const ye = expenseRaw.filter((e) => e.year === y);
    const incTotal = yi.reduce((s, e) => s + e.amount, 0);
    const expTotal = ye.reduce((s, e) => s + e.amount, 0);
    console.log(`  ${y}: ${yi.length} income ($${incTotal.toLocaleString()}), ${ye.length} expenses ($${expTotal.toLocaleString()}), Net: $${(incTotal - expTotal).toLocaleString()}`);
  }

  console.log(`\nTotal: ${incomeEntries.length} income, ${expenseEntries.length} expenses`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
