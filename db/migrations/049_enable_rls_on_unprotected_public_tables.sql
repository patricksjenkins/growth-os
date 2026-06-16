-- 049_enable_rls_on_unprotected_public_tables.sql
-- Security: Supabase advisor flagged rls_disabled_in_public ERRORs on six public
-- tables. Enable RLS on all of them. Two are tenant-scoped (get tenant_iso
-- policies keyed on app_metadata.tenant_id); four are platform-global and
-- intentionally have NO policy, which means service-role-only access (the API
-- reaches them with the service-role key; no anon/authenticated client can).
--
-- Idempotent: ENABLE ROW LEVEL SECURITY is a no-op if already on; policies are
-- dropped-if-exists before create.

-- Tenant-scoped tables.
ALTER TABLE public.client_health_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_health_checks ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  DROP POLICY IF EXISTS tenant_iso_client_health_scores ON public.client_health_scores;
  CREATE POLICY tenant_iso_client_health_scores ON public.client_health_scores FOR ALL
    USING (auth.role() = 'service_role' OR tenant_id = NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid);

  DROP POLICY IF EXISTS tenant_iso_tenant_health_checks ON public.tenant_health_checks;
  CREATE POLICY tenant_iso_tenant_health_checks ON public.tenant_health_checks FOR ALL
    USING (auth.role() = 'service_role' OR tenant_id = NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid);
END $$;

-- Platform-global tables: RLS on, no policy => service-role-only.
ALTER TABLE public.ai_safety_switches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_safety_switch_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_approved_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_health_checks ENABLE ROW LEVEL SECURITY;
