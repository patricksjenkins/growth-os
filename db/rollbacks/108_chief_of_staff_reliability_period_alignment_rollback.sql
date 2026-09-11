-- Restore the migration-087 UTC date-cast predicate. This rollback changes
-- only function code; it does not rewrite report, control, tenant, or customer
-- rows.

DO $rollback$
DECLARE
  v_signature regprocedure := (
    'public.cos_report_command_rpc(' ||
    'uuid,text,text,uuid,integer,text,uuid,uuid,date,date,text,text,jsonb,' ||
    'bigint,text,text,text,text,text,jsonb,boolean)'
  )::regprocedure;
  v_definition text;
  v_previous text := $previous$source_report.period_start::date = p_reporting_period_start
         AND source_report.period_end::date = p_reporting_period_end$previous$;
  v_aligned text := $aligned$(source_report.period_start AT TIME ZONE 'America/New_York')::date
           = p_reporting_period_start
         AND ((source_report.period_end - interval '1 microsecond')
              AT TIME ZONE 'America/New_York')::date
           = p_reporting_period_end$aligned$;
  v_occurrences integer;
BEGIN
  SELECT pg_get_functiondef(v_signature) INTO v_definition;
  v_occurrences := (
    char_length(v_definition) - char_length(replace(v_definition, v_aligned, ''))
  ) / char_length(v_aligned);

  IF v_occurrences = 0 AND position(v_previous IN v_definition) > 0 THEN
    RETURN;
  END IF;
  IF v_occurrences <> 1 THEN
    RAISE EXCEPTION 'cos_report_period_alignment_rollback_source_drift';
  END IF;

  EXECUTE replace(v_definition, v_aligned, v_previous);
END;
$rollback$;

DROP FUNCTION IF EXISTS public.cos_report_period_alignment_version();

