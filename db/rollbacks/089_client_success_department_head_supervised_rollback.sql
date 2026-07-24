-- Evidence-preserving rollback for migration 089.
-- Operational entry points and write triggers are removed; all accepted
-- support snapshots, charters, reports, work, decisions, exceptions, and
-- events remain queryable.

UPDATE public.client_success_head_controls
SET enabled = false,
    execution_mode = 'disabled',
    kill_switch_engaged = true,
    activation_evidence = activation_evidence || jsonb_build_object(
      'rollback_engaged_at', now(),
      'rollback_mode', 'evidence_retained'
    );

REVOKE ALL ON FUNCTION public.client_success_head_charter_register_rpc(
  uuid, integer, text, integer, integer, integer, integer, integer,
  uuid, jsonb, text, text, boolean
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.client_success_support_snapshot_record_rpc(
  uuid, uuid, uuid, text, text, timestamptz, text, integer, integer,
  integer, integer, numeric, numeric, integer, text, text, text, text, boolean
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.client_success_head_report_accept_rpc(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, date, date, text, text, jsonb,
  text, text, boolean
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.client_success_head_work_command_rpc(
  uuid, uuid, uuid, text, bigint, text, text, text, jsonb, text, text,
  boolean, text, text, text, text, text, timestamptz, text, text, text
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.client_success_head_kill_switch_rpc(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;

DROP FUNCTION IF EXISTS public.client_success_head_charter_register_rpc(
  uuid, integer, text, integer, integer, integer, integer, integer,
  uuid, jsonb, text, text, boolean
);
DROP FUNCTION IF EXISTS public.client_success_support_snapshot_record_rpc(
  uuid, uuid, uuid, text, text, timestamptz, text, integer, integer,
  integer, integer, numeric, numeric, integer, text, text, text, text, boolean
);
DROP FUNCTION IF EXISTS public.client_success_head_report_accept_rpc(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, date, date, text, text, jsonb,
  text, text, boolean
);
DROP FUNCTION IF EXISTS public.client_success_head_work_command_rpc(
  uuid, uuid, uuid, text, bigint, text, text, text, jsonb, text, text,
  boolean, text, text, text, text, text, timestamptz, text, text, text
);
DROP FUNCTION IF EXISTS public.client_success_head_kill_switch_rpc(uuid, text);
DROP FUNCTION IF EXISTS public.client_success_head_assert_control(uuid, boolean);
DROP FUNCTION IF EXISTS public.client_success_head_evidence_digest(jsonb);

DROP TRIGGER IF EXISTS trg_client_success_head_control_guard
  ON public.client_success_head_controls;
DROP TRIGGER IF EXISTS trg_client_success_head_item_identity_guard
  ON public.client_success_head_items;
DROP TRIGGER IF EXISTS trg_client_success_head_charters_immutable
  ON public.client_success_head_charters;
DROP TRIGGER IF EXISTS trg_client_success_support_snapshot_tenant_guard
  ON public.client_success_support_snapshots;
DROP TRIGGER IF EXISTS trg_client_success_support_snapshots_immutable
  ON public.client_success_support_snapshots;
DROP TRIGGER IF EXISTS trg_client_success_head_reports_immutable
  ON public.client_success_head_reports;
DROP TRIGGER IF EXISTS trg_client_success_head_events_immutable
  ON public.client_success_head_events;

DROP FUNCTION IF EXISTS public.client_success_head_control_guard();
DROP FUNCTION IF EXISTS public.client_success_head_item_identity_guard();
DROP FUNCTION IF EXISTS public.client_success_head_immutable_row();
DROP FUNCTION IF EXISTS public.client_success_support_snapshot_tenant_guard();

COMMENT ON TABLE public.client_success_head_reports IS
  'RETAINED EVIDENCE after rollback 089; no mutation RPC remains.';
COMMENT ON TABLE public.client_success_support_snapshots IS
  'RETAINED CANONICAL SUPPORT EVIDENCE after rollback 089; no mutation RPC remains.';
COMMENT ON TABLE public.client_success_head_events IS
  'RETAINED AUDIT EVIDENCE after rollback 089; no mutation RPC remains.';
