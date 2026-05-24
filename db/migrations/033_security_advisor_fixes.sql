-- Growth OS: Address Supabase Security Advisor warnings (2026-05-20)
--
-- Two issue categories surfaced by the linter:
--
--   1. CRITICAL — SECURITY DEFINER functions executable by public/anon/
--      authenticated. These run with the function owner's permissions
--      (typically postgres/service_role). Granting EXECUTE to public
--      means anyone with the public anon key (shipped in client apps)
--      can call them through the REST RPC endpoint and effectively
--      bypass RLS. exec_sql is the worst — it runs arbitrary SQL.
--
--   2. LOW-MEDIUM — Mutable search_path on functions. If a function
--      doesn't pin its search_path, an attacker who can influence the
--      session's search_path could trick the function into resolving
--      a built-in name (like `format(...)`) to a malicious schema
--      object. Always pin to `public, pg_temp` for hardened functions.
--
-- All four SECURITY DEFINER functions below are server-only callers
-- (verified by tracing core/usage-caps.js + scripts/migrate.js +
-- core/db/* triggers). Revoking EXECUTE from public/anon/authenticated
-- breaks nothing — service_role still has full access since it
-- bypasses RLS and was implicitly granted on creation.

-- ============================================================================
-- 1. Revoke public/anon/authenticated EXECUTE from sensitive SECURITY DEFINER
--    functions. service_role retains its implicit grant.
-- ============================================================================

REVOKE EXECUTE ON FUNCTION exec_sql(text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION increment_usage(uuid, text, bigint) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION increment_voice_minutes(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION finance_entries_audit_trigger() FROM PUBLIC, anon, authenticated;

-- ============================================================================
-- 2. Pin search_path on every function the linter flagged. Using
--    ALTER FUNCTION ... SET search_path = ... preserves the function body
--    so we don't have to redeclare it.
-- ============================================================================

ALTER FUNCTION is_period_locked(uuid, integer, integer) SET search_path = public, pg_temp;
ALTER FUNCTION attention_queue_counters(uuid)            SET search_path = public, pg_temp;
ALTER FUNCTION increment_usage(uuid, text, bigint)       SET search_path = public, pg_temp;
ALTER FUNCTION increment_voice_minutes(uuid, integer)    SET search_path = public, pg_temp;
ALTER FUNCTION finance_entries_set_updated_at()          SET search_path = public, pg_temp;
ALTER FUNCTION exec_sql(text)                            SET search_path = public, pg_temp;
ALTER FUNCTION set_tenant_context(uuid)                  SET search_path = public, pg_temp;
ALTER FUNCTION finance_entries_audit_trigger()           SET search_path = public, pg_temp;
