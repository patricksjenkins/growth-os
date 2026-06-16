-- 051_pin_function_search_path.sql
-- Security hardening: Supabase advisor warns (function_search_path_mutable) when
-- a function has no fixed search_path — a caller could shadow built-in objects by
-- manipulating their own search_path. Pinning to "public, pg_temp" preserves the
-- existing object resolution (these functions reference public-schema tables) while
-- closing the mutable-search_path vector. No behavior change.
--
-- set_audit_context is additionally SECURITY DEFINER (runs as owner), so a pinned
-- search_path matters most there. These functions back the 923A customer-site
-- schema (trigger touch fns, sequence helpers) plus the finance audit context.

ALTER FUNCTION public.customers_touch() SET search_path = public, pg_temp;
ALTER FUNCTION public.proposals_touch() SET search_path = public, pg_temp;
ALTER FUNCTION public.invoices_touch() SET search_path = public, pg_temp;
ALTER FUNCTION public.project_proofs_touch() SET search_path = public, pg_temp;
ALTER FUNCTION public.project_shares_touch() SET search_path = public, pg_temp;
ALTER FUNCTION public.asset_touch() SET search_path = public, pg_temp;
ALTER FUNCTION public.deal_lifecycle_touch() SET search_path = public, pg_temp;
ALTER FUNCTION public.sequence_sends_touch() SET search_path = public, pg_temp;
ALTER FUNCTION public.dle_pages_touch() SET search_path = public, pg_temp;
ALTER FUNCTION public.seq_next(p_tenant uuid, p_kind text, p_year integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.claim_send(p_id uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.set_audit_context(p_actor_id uuid, p_actor_label text) SET search_path = public, pg_temp;
