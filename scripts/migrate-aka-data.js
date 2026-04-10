/**
 * Phase 3F: Migrate A Kut Above legacy data to Growth OS
 *
 * Source: Legacy AKA Supabase (fogmqtnvmwahkmngmkds)
 *   - income_entries → finance_entries (entry_type='income')
 *   - expense_entries → finance_entries (entry_type='expense')
 *   - debt_tracker → debt_tracker (add tenant_id)
 *   - crew_members → crew_members (add tenant_id, map IDs)
 *   - crew_daily_log → crew_daily_log (add tenant_id, remap crew_member_id)
 *
 * Target: Growth OS Supabase (ffvezmgvwpohbsbigcdb)
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

// ── Clients ──────────────────────────────────────────────────────────────────
const legacy = createClient(
  'https://fogmqtnvmwahkmngmkds.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZvZ21xdG52bXdhaGttbmdta2RzIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NTA1OTIxMiwiZXhwIjoyMDkwNjM1MjEyfQ.ueTwtlQqZGKFCzg1LicgznUHuDwfzZoQNlBRQuYEP4M'
);

const growthOS = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const AKA_TENANT_ID = 'cad0a1a7-886c-4dfc-b23c-76e9bf195784';
const BATCH_SIZE = 500;

// ── Helpers ──────────────────────────────────────────────────────────────────

async function fetchAll(client, table) {
  // Supabase limits to 1000 rows per request; paginate
  const all = [];
  let offset = 0;
  while (true) {
    const { data, error } = await client
      .from(table)
      .select('*')
      .range(offset, offset + 999)
      .order('created_at', { ascending: true });
    if (error) throw new Error(`Failed to fetch ${table}: ${error.message}`);
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < 1000) break;
    offset += 1000;
  }
  return all;
}

async function insertBatch(table, rows) {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await growthOS.from(table).insert(batch);
    if (error) throw new Error(`Failed to insert into ${table} at offset ${i}: ${error.message}`);
    inserted += batch.length;
  }
  return inserted;
}

// ── Migration Steps ──────────────────────────────────────────────────────────

async function migrateIncome() {
  console.log('\n📥 Migrating income_entries → finance_entries...');
  const rows = await fetchAll(legacy, 'income_entries');
  console.log(`  Found ${rows.length} legacy income entries`);

  const transformed = rows.map(r => ({
    tenant_id: AKA_TENANT_ID,
    entry_type: 'income',
    customer_name: r.customer_name,
    amount: r.amount,
    date: r.date,
    job_type: r.job_type || null,
    description: r.notes || null,
    category: null,
    recurring: false,
    metadata: {},
  }));

  const count = await insertBatch('finance_entries', transformed);
  console.log(`  ✅ Migrated ${count} income entries`);
  return count;
}

async function migrateExpenses() {
  console.log('\n📥 Migrating expense_entries → finance_entries...');
  const rows = await fetchAll(legacy, 'expense_entries');
  console.log(`  Found ${rows.length} legacy expense entries`);

  const transformed = rows.map(r => ({
    tenant_id: AKA_TENANT_ID,
    entry_type: 'expense',
    description: r.description,
    category: r.category || 'Other',
    amount: r.amount,
    date: r.date,
    recurring: r.is_recurring || false,
    customer_name: null,
    job_type: null,
    metadata: {},
  }));

  const count = await insertBatch('finance_entries', transformed);
  console.log(`  ✅ Migrated ${count} expense entries`);
  return count;
}

async function migrateDebt() {
  console.log('\n📥 Migrating debt_tracker...');
  const rows = await fetchAll(legacy, 'debt_tracker');
  console.log(`  Found ${rows.length} legacy debts`);

  const transformed = rows.map(r => ({
    tenant_id: AKA_TENANT_ID,
    name: r.name,
    original_amount: r.original_amount,
    current_balance: r.current_balance,
    monthly_payment: r.monthly_payment || 0,
    status: r.status || 'active',
    notes: r.notes || null,
  }));

  const count = await insertBatch('debt_tracker', transformed);
  console.log(`  ✅ Migrated ${count} debts`);
  return count;
}

async function migrateCrew() {
  console.log('\n📥 Migrating crew_members...');
  const rows = await fetchAll(legacy, 'crew_members');
  console.log(`  Found ${rows.length} legacy crew members`);

  // Insert crew and build old→new ID map
  const idMap = {};
  for (const r of rows) {
    const { data, error } = await growthOS
      .from('crew_members')
      .insert({
        tenant_id: AKA_TENANT_ID,
        name: r.name,
        daily_rate: r.daily_rate,
        is_active: r.is_active ?? true,
        status: (r.is_active ?? true) ? 'active' : 'inactive',
      })
      .select('id')
      .single();

    if (error) throw new Error(`Failed to insert crew member ${r.name}: ${error.message}`);
    idMap[r.id] = data.id;
  }

  console.log(`  ✅ Migrated ${rows.length} crew members`);
  return { count: rows.length, idMap };
}

async function migrateCrewLogs(crewIdMap) {
  console.log('\n📥 Migrating crew_daily_log...');
  const rows = await fetchAll(legacy, 'crew_daily_log');
  console.log(`  Found ${rows.length} legacy crew log entries`);

  let skipped = 0;
  const transformed = [];
  for (const r of rows) {
    const newCrewId = crewIdMap[r.crew_member_id];
    if (!newCrewId) {
      skipped++;
      continue;
    }
    transformed.push({
      tenant_id: AKA_TENANT_ID,
      crew_member_id: newCrewId,
      date: r.date,
      worked: r.worked ?? true,
    });
  }

  if (skipped > 0) console.log(`  ⚠️  Skipped ${skipped} logs with unmapped crew IDs`);

  const count = await insertBatch('crew_daily_log', transformed);
  console.log(`  ✅ Migrated ${count} crew log entries`);
  return count;
}

// ── Verification ─────────────────────────────────────────────────────────────

async function verify() {
  console.log('\n🔍 Verifying migration...');
  const [fe, dt, cm, cl] = await Promise.all([
    growthOS.from('finance_entries').select('id', { count: 'exact', head: true }).eq('tenant_id', AKA_TENANT_ID),
    growthOS.from('debt_tracker').select('id', { count: 'exact', head: true }).eq('tenant_id', AKA_TENANT_ID),
    growthOS.from('crew_members').select('id', { count: 'exact', head: true }).eq('tenant_id', AKA_TENANT_ID),
    growthOS.from('crew_daily_log').select('id', { count: 'exact', head: true }).eq('tenant_id', AKA_TENANT_ID),
  ]);

  // Also get income/expense breakdown
  const [inc, exp] = await Promise.all([
    growthOS.from('finance_entries').select('id', { count: 'exact', head: true }).eq('tenant_id', AKA_TENANT_ID).eq('entry_type', 'income'),
    growthOS.from('finance_entries').select('id', { count: 'exact', head: true }).eq('tenant_id', AKA_TENANT_ID).eq('entry_type', 'expense'),
  ]);

  console.log('  Growth OS counts for AKA tenant:');
  console.log(`    finance_entries: ${fe.count} (income: ${inc.count}, expense: ${exp.count})`);
  console.log(`    debt_tracker:    ${dt.count}`);
  console.log(`    crew_members:    ${cm.count}`);
  console.log(`    crew_daily_log:  ${cl.count}`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Phase 3F: A Kut Above Data Migration');
  console.log('  Legacy (fogmqtnvmwahkmngmkds) → Growth OS (ffvezmgvwpohbsbigcdb)');
  console.log('═══════════════════════════════════════════════════');

  const dryRun = process.argv.includes('--dry-run');
  if (dryRun) {
    console.log('\n⚠️  DRY RUN — counting source data only\n');
    const tables = ['income_entries', 'expense_entries', 'debt_tracker', 'crew_members', 'crew_daily_log'];
    for (const t of tables) {
      const rows = await fetchAll(legacy, t);
      console.log(`  ${t}: ${rows.length} rows`);
    }
    console.log('\nDry run complete. Remove --dry-run to execute migration.');
    return;
  }

  try {
    await migrateIncome();
    await migrateExpenses();
    await migrateDebt();
    const { idMap } = await migrateCrew();
    await migrateCrewLogs(idMap);
    await verify();
    console.log('\n✅ Migration complete!');
  } catch (err) {
    console.error('\n❌ Migration failed:', err.message);
    process.exit(1);
  }
}

main();
