-- Migration 093: Resolve pgcrypto digest functions in managed Supabase.
--
-- Supabase installs pgcrypto in the `extensions` schema. The autonomous
-- control-plane functions created in migrations 085-092 intentionally pin
-- their search path, but the original path omitted `extensions`. PostgreSQL
-- therefore could not resolve unqualified digest(...) calls in production,
-- even though the same functions worked in disposable databases where
-- pgcrypto was installed in `public`.
--
-- This migration changes only function configuration. It does not alter data,
-- grants, authority, tenant policies, or any customer/provider path.

BEGIN;

DO $migration$
DECLARE
  target_function record;
BEGIN
  FOR target_function IN
    SELECT
      namespace.nspname AS schema_name,
      procedure.proname AS function_name,
      pg_get_function_identity_arguments(procedure.oid)
        AS identity_arguments
    FROM pg_proc procedure
    JOIN pg_namespace namespace
      ON namespace.oid = procedure.pronamespace
    JOIN pg_language language
      ON language.oid = procedure.prolang
    WHERE namespace.nspname = 'public'
      AND language.lanname IN ('plpgsql', 'sql')
      AND procedure.prokind = 'f'
      AND (
        procedure.proname LIKE 'reliability_head_%'
        OR procedure.proname LIKE 'revenue_head_%'
        OR procedure.proname LIKE 'cos_%'
        OR procedure.proname LIKE 'chief_of_staff_%'
        OR procedure.proname LIKE 'onboarding_head_%'
        OR procedure.proname LIKE 'onboarding_customer_outcome_%'
        OR procedure.proname LIKE 'client_success_head_%'
        OR procedure.proname LIKE 'finance_governance_%'
        OR procedure.proname LIKE 'marketing_brand_%'
        OR procedure.proname LIKE 'product_engineering_%'
      )
      AND pg_get_functiondef(procedure.oid) ~
        '(^|[^[:alnum:]_.])digest[[:space:]]*[(]'
  LOOP
    EXECUTE format(
      'ALTER FUNCTION %I.%I(%s) SET search_path TO pg_catalog, public, extensions',
      target_function.schema_name,
      target_function.function_name,
      target_function.identity_arguments
    );
  END LOOP;
END;
$migration$;

COMMIT;
