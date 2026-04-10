/**
 * Growth OS — Seed Tenant Script
 *
 * Usage:
 *   node scripts/seed-tenant.js --name "A Kut Above" --slug a-kut-above --vertical tree_service --email owner@example.com
 *   node scripts/seed-tenant.js --name "WellMor Benefits" --slug wellmor --vertical benefits_consulting --email morgan@wellmor.com
 */

require('dotenv').config();
const { db } = require('../db/client');

async function seedTenant({ name, slug, vertical, email }) {
  console.log(`\nSeeding tenant: ${name} (${vertical})`);

  // Load preset
  let preset;
  // Preset files use dashes, verticals use underscores
  const presetFile = vertical.replace(/_/g, '-');
  try {
    preset = require(`../config/presets/${presetFile}`);
  } catch (e) {
    console.error(`No preset found for vertical: ${vertical} (looked for config/presets/${presetFile}.js)`);
    process.exit(1);
  }

  // 1. Create tenant
  const { data: tenant, error: tenantErr } = await db
    .from('tenants')
    .upsert({ name, slug, vertical, status: 'active', owner_email: email }, { onConflict: 'slug' })
    .select()
    .single();

  if (tenantErr) { console.error('Failed to create tenant:', tenantErr); process.exit(1); }
  console.log(`  ✓ Tenant created: ${tenant.id}`);

  // 2. Seed modules
  const moduleRows = Object.entries(preset.modules).map(([module, enabled]) => ({
    tenant_id: tenant.id,
    module,
    enabled,
    config: {}
  }));

  const { error: modErr } = await db
    .from('tenant_modules')
    .upsert(moduleRows, { onConflict: 'tenant_id,module' });
  if (modErr) console.error('Module seed error:', modErr);
  else console.log(`  ✓ ${moduleRows.length} modules seeded`);

  // 3. Seed config
  const configRows = Object.entries(preset.config).map(([key, value]) => ({
    tenant_id: tenant.id,
    key,
    value
  }));

  const { error: cfgErr } = await db
    .from('tenant_config')
    .upsert(configRows, { onConflict: 'tenant_id,key' });
  if (cfgErr) console.error('Config seed error:', cfgErr);
  else console.log(`  ✓ ${configRows.length} config keys seeded`);

  console.log(`\n✓ Tenant "${name}" ready (${tenant.id})\n`);
  return tenant;
}

// Parse CLI args
const args = process.argv.slice(2);
function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}

const name = getArg('--name');
const slug = getArg('--slug');
const vertical = getArg('--vertical');
const email = getArg('--email') || '';

if (!name || !slug || !vertical) {
  console.log('Usage: node scripts/seed-tenant.js --name "Name" --slug slug --vertical vertical [--email email]');
  console.log('Verticals: tree_service, benefits_consulting');
  process.exit(1);
}

seedTenant({ name, slug, vertical, email })
  .then(() => process.exit(0))
  .catch(err => { console.error(err); process.exit(1); });
