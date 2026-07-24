-- Rollback 091 contains every Marketing & Brand Head mutation path while
-- retaining accepted reports, source links, cases, and immutable event evidence.

UPDATE public.marketing_brand_head_controls
   SET enabled = false,
       execution_mode = 'disabled',
       kill_switch_engaged = true,
       updated_at = now();

DROP FUNCTION IF EXISTS public.marketing_brand_head_command_rpc(
  uuid, text, jsonb, bigint, text, text, text, text, jsonb, boolean
);
DROP FUNCTION IF EXISTS
  public.marketing_brand_head_kill_switch_rpc(uuid, text);

REVOKE INSERT, UPDATE, DELETE ON
  public.marketing_brand_head_controls,
  public.marketing_brand_head_reports,
  public.marketing_brand_report_artifacts,
  public.marketing_brand_report_quality,
  public.marketing_brand_report_deliveries,
  public.marketing_brand_head_cases,
  public.marketing_brand_head_events
FROM PUBLIC, anon, authenticated, service_role;

-- Deliberately no DROP TABLE: evidence survives rollback.
