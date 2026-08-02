/**
 * Seed First Gen Automate as a Growth OS tenant
 *
 * This makes FGA eat its own cooking — the same system we sell
 * to clients runs First Gen Automate's own business.
 *
 * All 14 modules active. Scale tier. Full automation.
 *
 * Usage:
 *   node scripts/seed-fga-tenant.js
 *   node scripts/seed-fga-tenant.js --reset
 */

require('dotenv').config();
const { db } = require('../db/client');

const SLUG = 'first-gen-automate';

async function seedFGA() {
  const isReset = process.argv.includes('--reset');

  if (isReset) {
    console.log('Resetting FGA tenant...');
    const { data: existing } = await db.from('tenants').select('id').eq('slug', SLUG).single();
    if (existing) {
      await db.from('tenant_modules').delete().eq('tenant_id', existing.id);
      await db.from('tenant_config').delete().eq('tenant_id', existing.id);
      await db.from('tenant_integrations').delete().eq('tenant_id', existing.id);
      await db.from('tenants').delete().eq('id', existing.id);
      console.log('  ✓ Previous FGA tenant deleted');
    }
  }

  // Load preset
  const preset = require('../config/presets/saas-company');

  // 1. Create tenant
  const { data: tenant, error: tenantErr } = await db
    .from('tenants')
    .upsert({
      name: 'First Gen Automate',
      slug: SLUG,
      vertical: 'saas_company',
      status: 'active',
      owner_email: 'patrick@firstgenautomate.com',
    }, { onConflict: 'slug' })
    .select()
    .single();

  if (tenantErr) { console.error('Failed to create tenant:', tenantErr); process.exit(1); }
  console.log(`✓ Tenant created: ${tenant.id} (${SLUG})`);

  // 2. Seed all modules (all 14 enabled)
  const moduleRows = Object.entries(preset.modules).map(([module, enabled]) => ({
    tenant_id: tenant.id,
    module,
    enabled,
    config: {},
  }));

  const { error: modErr } = await db
    .from('tenant_modules')
    .upsert(moduleRows, { onConflict: 'tenant_id,module' });
  if (modErr) console.error('Module seed error:', modErr);
  else console.log(`✓ ${moduleRows.length} modules enabled (all 14 + digest)`);

  // 3. Seed config
  const configRows = Object.entries(preset.config).map(([key, value]) => ({
    tenant_id: tenant.id,
    key,
    value: typeof value === 'object' ? value : value,
  }));

  const { error: cfgErr } = await db
    .from('tenant_config')
    .upsert(configRows, { onConflict: 'tenant_id,key' });
  if (cfgErr) console.error('Config seed error:', cfgErr);
  else console.log(`✓ ${configRows.length} config keys seeded`);

  // 4. Seed integration placeholders (to be filled with real credentials)
  const integrations = [
    {
      tenant_id: tenant.id,
      service: 'buffer',
      credentials: {},
      config: { platforms: ['facebook', 'instagram', 'linkedin'] },
      status: 'pending_setup',
    },
    {
      tenant_id: tenant.id,
      service: 'stripe',
      credentials: {
        secret_key: process.env.STRIPE_SECRET_KEY || '',
        publishable_key: process.env.STRIPE_PUBLISHABLE_KEY || '',
      },
      config: {
        setup_price: process.env.STRIPE_SETUP_PRICE || '',
        growth_price: process.env.STRIPE_GROWTH_PRICE || '',
        scale_price: process.env.STRIPE_SCALE_PRICE || '',
      },
      status: 'active',
    },
    {
      tenant_id: tenant.id,
      service: 'resend',
      credentials: { api_key: process.env.RESEND_API_KEY || '' },
      config: { from_email: 'Patrick Jenkins <patrick@firstgenautomate.com>' },
      status: 'active',
    },
    {
      tenant_id: tenant.id,
      service: 'gmail',
      credentials: {},
      config: { email: 'patrick@firstgenautomate.com' },
      status: 'pending_setup',
    },
  ];

  const { error: intErr } = await db
    .from('tenant_integrations')
    .upsert(integrations, { onConflict: 'tenant_id,service' });
  if (intErr) console.error('Integration seed error:', intErr);
  else console.log(`✓ ${integrations.length} integrations seeded`);

  // Summary
  console.log('\n═══════════════════════════════════════════');
  console.log('  First Gen Automate — Tenant Ready');
  console.log('═══════════════════════════════════════════');
  console.log(`  Tenant ID:  ${tenant.id}`);
  console.log(`  Slug:       ${SLUG}`);
  console.log(`  Tier:       Scale (all 14 modules)`);
  console.log(`  Owner:      patrick@firstgenautomate.com`);
  console.log('');
  console.log('  Agents that will run for FGA:');
  console.log('  ─────────────────────────────');
  console.log('  • Speed-to-Lead      — Instant SMS on new demo requests');
  console.log('  • Missed Call         — Text-back when you miss a call');
  console.log('  • Follow-Up           — Automated prospect follow-ups');
  console.log('  • Content Generation  — AI writes social posts about Growth OS');
  console.log('  • Image Generation    — AI creates marketing visuals');
  console.log('  • Publisher           — Posts to Facebook, Instagram, LinkedIn');
  console.log('  • Review Requests     — Asks clients for Google reviews');
  console.log('  • Referral Requests   — Asks happy clients for referrals');
  console.log('  • Social Engagement   — Monitors and responds to comments');
  console.log('  • Email Chief of Staff — Manages patrick@ inbox');
  console.log('  • Prospecting         — Finds small business owners who need Growth OS');
  console.log('  • Lead Scoring        — Ranks leads by likelihood to close');
  console.log('  • Enrichment          — Fills in prospect data automatically');
  console.log('  • Digest              — Daily + weekly summary to Patrick');
  console.log('');
  console.log('  Next steps:');
  console.log('  1. Connect the Telnyx number for SMS');
  console.log('  2. Connect Buffer for social publishing');
  console.log('  3. Connect Gmail OAuth for Email Chief of Staff');
  console.log('  4. Deploy to Railway and start the worker');
  console.log('═══════════════════════════════════════════\n');
}

seedFGA().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
