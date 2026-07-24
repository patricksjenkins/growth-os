-- ============================================================================
-- Rollback 076: disable closed-won onboarding handoff writes
--
-- Evidence-preserving rollback: remove the callable command boundary and
-- leave all immutable event and handoff records intact for audit/recovery.
-- Existing lead, customer, tenant, and onboarding tables are never changed.
-- ============================================================================

REVOKE EXECUTE ON FUNCTION public.closed_won_onboarding_handoff_rpc(
  text, uuid, text, text, text, text, uuid, integer, uuid, uuid, uuid, uuid,
  text, timestamptz, timestamptz, timestamptz, timestamptz, integer, text,
  text, text, text, text, timestamptz, boolean
) FROM PUBLIC, anon, authenticated, service_role;

DROP FUNCTION IF EXISTS public.closed_won_onboarding_handoff_rpc(
  text, uuid, text, text, text, text, uuid, integer, uuid, uuid, uuid, uuid,
  text, timestamptz, timestamptz, timestamptz, timestamptz, integer, text,
  text, text, text, text, timestamptz, boolean
);

COMMENT ON TABLE public.closed_won_onboarding_handoffs IS
  'Rollback 076 applied: command writes disabled; handoff and evidence retained.';
