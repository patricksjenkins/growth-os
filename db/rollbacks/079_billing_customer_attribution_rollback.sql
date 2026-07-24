-- Migration 079 rollback: containment-first and evidence preserving.
--
-- Before invoking, disable every billing attribution caller. This rollback
-- removes RPC execution paths and leaves immutable shadow evidence in place.
-- It does not alter finance_entries, customer records, totals, or provider data.

REVOKE EXECUTE ON FUNCTION public.billing_identity_register_rpc(
  uuid, text, uuid, text, text, text, text, text, text, text,
  timestamptz, text, text, text, text, boolean
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.finance_attribution_record_rpc(
  uuid, uuid, uuid, uuid, text, text, text, text, date, text, bigint,
  bigint, text, bigint, bigint, text, timestamptz, text, text, text,
  text, boolean
) FROM PUBLIC, anon, authenticated, service_role;

DROP FUNCTION IF EXISTS public.billing_identity_register_rpc(
  uuid, text, uuid, text, text, text, text, text, text, text,
  timestamptz, text, text, text, text, boolean
);
DROP FUNCTION IF EXISTS public.finance_attribution_record_rpc(
  uuid, uuid, uuid, uuid, text, text, text, text, date, text, bigint,
  bigint, text, bigint, bigint, text, timestamptz, text, text, text,
  text, boolean
);

-- Preserve the shadow ledger and all evidence. Direct service-role mutation
-- remains denied and RLS remains enabled after rollback.
REVOKE INSERT, UPDATE, DELETE ON
  public.billing_identity_mappings,
  public.finance_attribution_records
FROM service_role;
