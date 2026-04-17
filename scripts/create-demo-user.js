/**
 * Growth OS — Create Demo Supabase User
 *
 * Creates (or updates) the public demo login tied to the Summit Plumbing Co
 * demo tenant. Idempotent — safe to re-run. Stores tenant-specific metadata
 * in user_metadata so the mobile app reads vertical/branding/is_demo without
 * needing an extra backend roundtrip.
 *
 * Usage:
 *   node scripts/create-demo-user.js                 # create/update
 *   PUBLIC_DEMO_PASSWORD=xxxx node ... --rotate      # rotate password
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// The public demo credentials. These are documented on the marketing site
// and in sales collateral. Intentionally plain so prospects can log in
// without help. The demo tenant's is_demo=true flag is what keeps them
// from doing real damage.
const DEMO_EMAIL = 'demo@firstgenautomate.com';
const DEMO_PASSWORD = process.env.PUBLIC_DEMO_PASSWORD || 'Demo2026!';
const DEMO_TENANT_SLUG = 'demo-service-pro';

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in env');
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // 1. Resolve the demo tenant so we can populate user_metadata from it.
  const { data: tenant, error: tenantErr } = await supabase
    .from('tenants')
    .select('id, name, slug, vertical, branding, is_demo')
    .eq('slug', DEMO_TENANT_SLUG)
    .maybeSingle();

  if (tenantErr || !tenant) {
    console.error(`Demo tenant '${DEMO_TENANT_SLUG}' not found. Run:`);
    console.error('  node scripts/seed-demo-service-pro.js');
    process.exit(1);
  }

  console.log(`Resolved demo tenant: ${tenant.name} (${tenant.id})`);

  const userMetadata = {
    role: 'client_owner',          // prospect sees the owner experience
    tenant_id: tenant.id,
    tenant_slug: tenant.slug,
    vertical: tenant.vertical,     // 'home_services'
    business_name: tenant.name,    // 'Summit Plumbing Co'
    branding: tenant.branding || {},
    is_demo: true,
  };

  // 2. Look up existing user. Supabase admin API doesn't have a direct
  // getUserByEmail, so we page through users and match.
  let existingUser = null;
  let page = 1;
  while (!existingUser) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) { console.error('listUsers error:', error); process.exit(1); }
    existingUser = (data?.users || []).find((u) => u.email === DEMO_EMAIL);
    if (existingUser) break;
    if (!data?.users || data.users.length < 200) break; // no more pages
    page += 1;
    if (page > 50) break; // safety
  }

  if (existingUser) {
    console.log(`Updating existing demo user ${existingUser.id}`);
    const rotate = process.argv.includes('--rotate');
    const updates = { user_metadata: userMetadata };
    if (rotate) updates.password = DEMO_PASSWORD;
    const { error: updErr } = await supabase.auth.admin.updateUserById(
      existingUser.id,
      updates,
    );
    if (updErr) { console.error('updateUser error:', updErr); process.exit(1); }
    console.log(`  ✓ Metadata updated${rotate ? ' (password rotated)' : ''}`);
  } else {
    console.log(`Creating demo user ${DEMO_EMAIL}`);
    const { data, error } = await supabase.auth.admin.createUser({
      email: DEMO_EMAIL,
      password: DEMO_PASSWORD,
      email_confirm: true,          // skip the confirmation email
      user_metadata: userMetadata,
    });
    if (error) { console.error('createUser error:', error); process.exit(1); }
    console.log(`  ✓ Created user ${data.user.id}`);
  }

  console.log('\n─────────────────────────────────────');
  console.log('✅ Demo login ready');
  console.log('─────────────────────────────────────');
  console.log(`  Email:    ${DEMO_EMAIL}`);
  console.log(`  Password: ${DEMO_PASSWORD}`);
  console.log(`  Tenant:   ${tenant.name}`);
  console.log(`  Role:     client_owner`);
  console.log(`  is_demo:  true  (real integrations are mocked)`);
  console.log('─────────────────────────────────────\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
