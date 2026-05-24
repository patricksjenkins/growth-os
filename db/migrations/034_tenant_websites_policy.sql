-- Growth OS: Add tenant_iso policy for tenant_websites
--
-- The Supabase Security Advisor flagged tenant_websites as "RLS Enabled
-- No Policy". RLS was on, but no policy existed — meaning anon and
-- authenticated callers were getting zero rows (the secure default) and
-- only service_role had access (which is what the server uses).
--
-- That state was already secure, but we add an explicit policy here to:
--   1. Match the per-tenant isolation convention used in 003_rls_policies.sql
--   2. Clear the advisor warning
--   3. Future-proof for when the mobile app / web portal want to read
--      the tenant's own DFY website status directly (currently they go
--      through the API server, but a direct supabase.from() call would
--      now return only their own row instead of zero rows)

ALTER TABLE tenant_websites ENABLE ROW LEVEL SECURITY;  -- idempotent; already on

CREATE POLICY tenant_iso_websites ON tenant_websites
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
