-- Migration 082 rollback: containment first, evidence preserving.
--
-- Disable all callers before applying. This removes every RPC mutation path
-- while retaining immutable artifact, rubric, calibration, evaluation, and
-- delivery evidence. It does not alter the legacy content publisher.

REVOKE EXECUTE ON FUNCTION public.content_artifact_version_register_rpc(
  uuid, uuid, integer, text, text, text, timestamptz, text, text, text, boolean
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.content_quality_rubric_register_rpc(
  uuid, text, integer, numeric, jsonb, text, text, timestamptz, text, text,
  text, boolean
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.content_quality_calibration_record_rpc(
  uuid, uuid, integer, integer, text, text, text, timestamptz, text, text,
  text, boolean
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.content_quality_evaluation_record_rpc(
  uuid, uuid, uuid, uuid, numeric, jsonb, text, text, timestamptz, text,
  text, text, boolean
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.content_delivery_receipt_record_rpc(
  uuid, uuid, uuid, uuid, text, text, text, text, integer, text, text, text,
  text, text, text, timestamptz, text, text, timestamptz, text, text, text,
  boolean
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.content_delivery_kill_switch_rpc(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;

DROP FUNCTION IF EXISTS public.content_artifact_version_register_rpc(
  uuid, uuid, integer, text, text, text, timestamptz, text, text, text, boolean
);
DROP FUNCTION IF EXISTS public.content_quality_rubric_register_rpc(
  uuid, text, integer, numeric, jsonb, text, text, timestamptz, text, text,
  text, boolean
);
DROP FUNCTION IF EXISTS public.content_quality_calibration_record_rpc(
  uuid, uuid, integer, integer, text, text, text, timestamptz, text, text,
  text, boolean
);
DROP FUNCTION IF EXISTS public.content_quality_evaluation_record_rpc(
  uuid, uuid, uuid, uuid, numeric, jsonb, text, text, timestamptz, text,
  text, text, boolean
);
DROP FUNCTION IF EXISTS public.content_delivery_receipt_record_rpc(
  uuid, uuid, uuid, uuid, text, text, text, text, integer, text, text, text,
  text, text, text, timestamptz, text, text, timestamptz, text, text, text,
  boolean
);
DROP FUNCTION IF EXISTS public.content_delivery_kill_switch_rpc(uuid, text);
DROP FUNCTION IF EXISTS public.content_delivery_assert_control(uuid, boolean);

REVOKE INSERT, UPDATE, DELETE ON
  public.content_delivery_automation_controls,
  public.content_artifact_versions,
  public.content_quality_rubric_versions,
  public.content_quality_calibrations,
  public.content_quality_evaluations,
  public.content_delivery_receipts
FROM service_role;
