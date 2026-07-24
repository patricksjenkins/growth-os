-- Migration 086 rollback: contain first and preserve evidence.
--
-- Stop all Revenue Head callers before applying. This rollback engages every
-- tenant kill switch, removes all mutation RPCs, and retains charters, accepted
-- reports, work, decisions, exceptions, events, RLS, and direct-write denial.

UPDATE public.revenue_head_controls
   SET enabled = false,
       execution_mode = 'disabled',
       kill_switch_engaged = true,
       activation_evidence = activation_evidence || jsonb_build_object(
         'rollback_contained_at', now()
       );

REVOKE EXECUTE ON FUNCTION public.revenue_head_charter_register_rpc(
  uuid, integer, text, integer, integer, integer, integer, integer, integer,
  uuid, jsonb, text, text, boolean
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.revenue_head_report_accept_rpc(
  uuid, uuid, uuid, date, date, text, text, integer, integer, integer,
  integer, integer, integer, integer, bigint, bigint, text, numeric, jsonb,
  text, text, boolean
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.revenue_head_work_command_rpc(
  uuid, uuid, uuid, text, bigint, text, text, text, jsonb, text, text,
  boolean, text, text, text, text, text, timestamptz, text, text, text
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.revenue_head_kill_switch_rpc(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;

DROP FUNCTION IF EXISTS public.revenue_head_charter_register_rpc(
  uuid, integer, text, integer, integer, integer, integer, integer, integer,
  uuid, jsonb, text, text, boolean
);
DROP FUNCTION IF EXISTS public.revenue_head_report_accept_rpc(
  uuid, uuid, uuid, date, date, text, text, integer, integer, integer,
  integer, integer, integer, integer, bigint, bigint, text, numeric, jsonb,
  text, text, boolean
);
DROP FUNCTION IF EXISTS public.revenue_head_work_command_rpc(
  uuid, uuid, uuid, text, bigint, text, text, text, jsonb, text, text,
  boolean, text, text, text, text, text, timestamptz, text, text, text
);
DROP FUNCTION IF EXISTS public.revenue_head_kill_switch_rpc(uuid, text);
DROP FUNCTION IF EXISTS public.revenue_head_assert_control(uuid, boolean);
DROP FUNCTION IF EXISTS public.revenue_head_evidence_digest(jsonb);

REVOKE INSERT, UPDATE, DELETE ON
  public.revenue_head_controls,
  public.revenue_head_charters,
  public.revenue_head_reports,
  public.revenue_head_items,
  public.revenue_head_events
FROM service_role;
