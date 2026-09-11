-- Migration 108: align a completed Eastern business day with the underlying
-- Reliability Head report's exclusive timestamptz bounds.
--
-- The source report correctly stores one ET day as [04:00Z, 04:00Z) during
-- daylight time. Migration 087 compared both UTC date casts to the same
-- canonical DATE, making every otherwise-valid report fail at its end bound.
-- This is a surgical replacement of that one predicate in the existing
-- service-only command function. No control, report, tenant, or customer row
-- is changed by this migration.

DO $migration$
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
    char_length(v_definition) - char_length(replace(v_definition, v_previous, ''))
  ) / char_length(v_previous);

  IF v_occurrences = 0 AND position(v_aligned IN v_definition) > 0 THEN
    RETURN;
  END IF;
  IF v_occurrences <> 1 THEN
    RAISE EXCEPTION 'cos_report_period_alignment_source_drift';
  END IF;

  EXECUTE replace(v_definition, v_previous, v_aligned);
END;
$migration$;

CREATE OR REPLACE FUNCTION public.cos_report_period_alignment_version()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$ SELECT 108 $$;

REVOKE ALL ON FUNCTION public.cos_report_period_alignment_version() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cos_report_period_alignment_version() FROM anon;
REVOKE ALL ON FUNCTION public.cos_report_period_alignment_version() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.cos_report_period_alignment_version() TO service_role;

