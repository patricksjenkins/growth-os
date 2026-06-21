/**
 * Create the 923A Coins owner login for the native app.
 *
 * Email/password intentionally match the web command center login so the
 * owner uses ONE credential everywhere:
 *   923acoins@firstgenautomate.com / 923acoins
 *
 * role: client_owner  -> the app routes this user to the embedded
 * Command Center (extra.commandCenterUrl) per App.js line ~483.
 *
 * Idempotent. Real tenant — is_demo stays false, no data is touched.
 *
 *   node scripts/create-923a-owner.js            # create/update metadata
 *   node scripts/create-923a-owner.js --rotate   # also reset password
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const EMAIL = '923acoins@firstgenautomate.com';
const PASSWORD = process.env.OWNER_923A_PASSWORD || '923acoins';
const TENANT_SLUG = process.env.OWNER_923A_SLUG || '923a-coins-wtlff';

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in env');
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  const { data: tenant, error: tenantErr } = await supabase
    .from('tenants')
    .select('id, name, slug, vertical, branding, is_demo')
    .eq('slug', TENANT_SLUG)
    .maybeSingle();

  if (tenantErr || !tenant) {
    console.error(`Tenant '${TENANT_SLUG}' not found.`, tenantErr || '');
    process.exit(1);
  }
  console.log(`Resolved tenant: ${tenant.name} (${tenant.id})  is_demo=${tenant.is_demo}`);

  const userMetadata = {
    role: 'client_owner',
    tenant_id: tenant.id,
    tenant_slug: tenant.slug,
    vertical: tenant.vertical || null,
    business_name: tenant.name,
    branding: tenant.branding || {},
    is_demo: false,
  };
  const appMetadata = {
    tenant_id: tenant.id,
    tenant_slug: tenant.slug,
    role: 'client_owner',
  };

  // Find existing user by paging (no getUserByEmail in admin API).
  let existingUser = null;
  let page = 1;
  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) { console.error('listUsers error:', error); process.exit(1); }
    existingUser = (data?.users || []).find((u) => u.email === EMAIL);
    if (existingUser || !data?.users || data.users.length < 200) break;
    page += 1;
    if (page > 50) break;
  }

  if (existingUser) {
    const rotate = process.argv.includes('--rotate');
    const updates = { user_metadata: userMetadata, app_metadata: appMetadata };
    if (rotate) updates.password = PASSWORD;
    const { error: updErr } = await supabase.auth.admin.updateUserById(existingUser.id, updates);
    if (updErr) { console.error('updateUser error:', updErr); process.exit(1); }
    console.log(`  ✓ Updated existing user ${existingUser.id}${rotate ? ' (password rotated)' : ''}`);
  } else {
    const { data, error } = await supabase.auth.admin.createUser({
      email: EMAIL,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: userMetadata,
      app_metadata: appMetadata,
    });
    if (error) { console.error('createUser error:', error); process.exit(1); }
    console.log(`  ✓ Created user ${data.user.id}`);
  }

  console.log('\n─────────────────────────────────────');
  console.log('✅ 923A app login ready');
  console.log(`  Email:    ${EMAIL}`);
  console.log(`  Password: ${PASSWORD}`);
  console.log(`  Role:     client_owner  -> embedded Command Center`);
  console.log('─────────────────────────────────────\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
