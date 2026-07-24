-- Rollback 093: restore the pre-093 pinned search path.
--
-- Evidence and application data are untouched. Run only after disabling the
-- autonomous Department Head report writers.

BEGIN;

DO $rollback$
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
      'ALTER FUNCTION %I.%I(%s) SET search_path TO pg_catalog, public',
      target_function.schema_name,
      target_function.function_name,
      target_function.identity_arguments
    );
  END LOOP;
END;
$rollback$;

COMMIT;
