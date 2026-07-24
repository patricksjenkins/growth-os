-- ============================================================================
-- Migration 071: Referral tenant-integrity guard
-- Date: 2026-07-24
--
-- Additive protection for the existing referral workflow. It does not rewrite
-- any lead or credit. The migration refuses to proceed if historical rows
-- already contain a tenant mismatch so remediation requires explicit review.
--
-- ROLLBACK: db/rollbacks/071_referral_tenant_integrity_rollback.sql
-- ============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.referral_credits credit
      JOIN public.leads referrer ON referrer.id = credit.referrer_lead_id
     WHERE referrer.tenant_id <> credit.tenant_id
  ) OR EXISTS (
    SELECT 1
      FROM public.referral_credits credit
      JOIN public.leads referee ON referee.id = credit.referee_lead_id
     WHERE referee.tenant_id <> credit.tenant_id
  ) THEN
    RAISE EXCEPTION
      'referral tenant mismatch exists; refusing to install integrity guard';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.referral_credits_tenant_guard()
RETURNS trigger AS $$
BEGIN
  IF NEW.referrer_lead_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.leads
     WHERE id = NEW.referrer_lead_id AND tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'referrer lead tenant mismatch';
  END IF;

  IF NEW.referee_lead_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.leads
     WHERE id = NEW.referee_lead_id AND tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'referee lead tenant mismatch';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_referral_credits_tenant_guard
  ON public.referral_credits;
CREATE TRIGGER trg_referral_credits_tenant_guard
  BEFORE INSERT OR UPDATE ON public.referral_credits
  FOR EACH ROW EXECUTE FUNCTION public.referral_credits_tenant_guard();
