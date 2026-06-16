-- 052_set_audit_context_invoker.sql
-- Security hardening: Supabase advisor warns
-- (authenticated_security_definer_function_executable) that
-- public.set_audit_context is SECURITY DEFINER yet callable by the
-- `authenticated` role via PostgREST RPC.
--
-- We can't revoke EXECUTE from authenticated: the /api/finance/* routes use a
-- per-request user-JWT client (db/userClient.js getUserClient), so they call
-- this RPC AS the authenticated role to set the finance_entries audit-trail
-- actor context. That grant is load-bearing.
--
-- But the function never needed DEFINER in the first place: it only writes two
-- custom session GUCs (app.actor_id, app.actor_label) via set_config — an
-- operation any role may perform in its own session. It reads/modifies no data.
-- Switching to SECURITY INVOKER removes the privilege-escalation surface the
-- advisor flags while preserving identical behavior (the GUC is set in the same
-- authenticated session the subsequent finance write runs in, so the audit
-- trigger still reads it). Migration 035 originally marked it DEFINER only by
-- convention alongside its data-touching siblings.

CREATE OR REPLACE FUNCTION public.set_audit_context(
  p_actor_id uuid,
  p_actor_label text
) RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM set_config('app.actor_id', COALESCE(p_actor_id::text, ''), false);
  PERFORM set_config('app.actor_label', COALESCE(left(p_actor_label, 200), ''), false);
END;
$$;

-- Preserve the existing grants (least privilege: only authenticated + service_role).
REVOKE EXECUTE ON FUNCTION public.set_audit_context(uuid, text) FROM public;
REVOKE EXECUTE ON FUNCTION public.set_audit_context(uuid, text) FROM anon;
GRANT  EXECUTE ON FUNCTION public.set_audit_context(uuid, text) TO authenticated;
GRANT  EXECUTE ON FUNCTION public.set_audit_context(uuid, text) TO service_role;
