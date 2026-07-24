/**
 * Read-only aggregate audit of Supabase Auth tenant and role claims.
 *
 * Emits counts only. User IDs, emails, names, tenant IDs, and metadata values
 * are never printed.
 */

'use strict';

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function listAllUsers(db) {
  const users = [];
  for (let page = 1; ; page += 1) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const batch = data?.users || [];
    users.push(...batch);
    if (batch.length < 200) break;
  }
  return users;
}

async function main() {
  const db = createClient(
    required('SUPABASE_URL'),
    required('SUPABASE_SERVICE_KEY'),
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
  const users = await listAllUsers(db);
  const counts = {
    total_users: users.length,
    missing_app_tenant: 0,
    legacy_tenant_only: 0,
    tenant_claim_conflict: 0,
    missing_app_role: 0,
    legacy_role_only: 0,
    role_claim_conflict: 0,
  };

  for (const user of users) {
    const appTenant = user.app_metadata?.tenant_id || null;
    const legacyTenant = user.user_metadata?.tenant_id || null;
    const appRole = user.app_metadata?.role || null;
    const legacyRole = user.user_metadata?.role || null;

    if (!appTenant) counts.missing_app_tenant += 1;
    if (!appTenant && legacyTenant) counts.legacy_tenant_only += 1;
    if (appTenant && legacyTenant && appTenant !== legacyTenant) counts.tenant_claim_conflict += 1;
    if (!appRole) counts.missing_app_role += 1;
    if (!appRole && legacyRole) counts.legacy_role_only += 1;
    if (appRole && legacyRole && appRole !== legacyRole) counts.role_claim_conflict += 1;
  }

  console.log(JSON.stringify({
    captured_at: new Date().toISOString(),
    counts,
    enforcement_ready:
      counts.missing_app_tenant === 0 &&
      counts.tenant_claim_conflict === 0 &&
      counts.legacy_role_only === 0 &&
      counts.role_claim_conflict === 0,
  }, null, 2));
}

if (require.main === module) {
  main().catch(error => {
    console.error(JSON.stringify({
      success: false,
      error_code: error.code || error.name || 'claims_audit_failed',
    }));
    process.exit(1);
  });
}

module.exports = { listAllUsers };
