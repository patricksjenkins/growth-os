-- Growth OS: Enable RLS on tables flagged by Supabase Security Advisor
-- (Email received 2026-05-20, surfaced via supabase.com/.../advisors/security)
--
-- Flagged tables: tenants, tenant_users, support_threads, support_messages
-- All four are tenant-scoped and were missing RLS — meaning anyone with the
-- public anon key (shipped inside the marketing site + mobile apps by design)
-- could read/write them directly through the Supabase REST API without
-- authenticating, bypassing the API server entirely.
--
-- Fix follows the existing convention from 003_rls_policies.sql:
--   - ENABLE ROW LEVEL SECURITY on the table
--   - Add a FOR ALL policy keyed on app.tenant_id (set by API middleware
--     per request via set_tenant_context RPC)
--   - service_role key bypasses RLS automatically (Supabase default), so
--     the worker + admin endpoints (which use SUPABASE_SERVICE_ROLE_KEY)
--     are unaffected.

-- ----------------------------------------------------------------------
-- tenants
-- ----------------------------------------------------------------------
-- Each tenant only sees their own row. Admin endpoints (platform owner
-- listing every customer) use service_role and bypass this.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_iso_tenants ON tenants
  FOR ALL
  USING (id = current_setting('app.tenant_id', true)::uuid);

-- ----------------------------------------------------------------------
-- tenant_users
-- ----------------------------------------------------------------------
-- The user→tenant mapping table. Each tenant only sees its own users
-- (owner sees the workers on their account, etc.).
ALTER TABLE tenant_users ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_iso_tenant_users ON tenant_users
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ----------------------------------------------------------------------
-- support_threads
-- ----------------------------------------------------------------------
-- Customer support tickets are tenant-scoped. The platform-owner support
-- inbox (FGA reading every tenant's tickets) goes through service_role.
ALTER TABLE support_threads ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_iso_support_threads ON support_threads
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- ----------------------------------------------------------------------
-- support_messages
-- ----------------------------------------------------------------------
-- Messages don't carry tenant_id directly — they belong to a thread.
-- Policy joins through the parent thread's tenant_id.
ALTER TABLE support_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_iso_support_messages ON support_messages
  FOR ALL
  USING (
    thread_id IN (
      SELECT id FROM support_threads
      WHERE tenant_id = current_setting('app.tenant_id', true)::uuid
    )
  );
