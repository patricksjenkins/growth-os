-- Operator-invoked rollback for migration 071.
-- Removing this guard reopens a tenant-integrity risk and therefore requires
-- the same production approval as activating the migration.

DROP TRIGGER IF EXISTS trg_referral_credits_tenant_guard
  ON public.referral_credits;
DROP FUNCTION IF EXISTS public.referral_credits_tenant_guard();
