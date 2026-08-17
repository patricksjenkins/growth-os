-- 105: Durable delivery-attempt evidence for the FGA prospect drip.
--
-- drip_sends is an idempotency ledger: UNIQUE(enrollment_id, day_offset)
-- intentionally permits only one completed touch. It therefore cannot also
-- represent every transient deferral, pre-send stop, or provider/configuration
-- failure. This append-only companion table answers "why did nothing send?"
-- without weakening the send-once constraint.

CREATE TABLE IF NOT EXISTS public.drip_delivery_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  enrollment_id uuid NOT NULL REFERENCES public.drip_enrollments(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  day_offset integer,
  outcome text NOT NULL CHECK (outcome IN ('sent', 'skipped', 'stopped', 'failed', 'rescheduled')),
  reason text,
  error text,
  next_send_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_drip_delivery_attempts_enrollment
  ON public.drip_delivery_attempts(enrollment_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_drip_delivery_attempts_tenant_outcome
  ON public.drip_delivery_attempts(tenant_id, outcome, created_at DESC);

ALTER TABLE public.drip_delivery_attempts ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.drip_delivery_attempts IS
  'Append-only evidence for every evaluated drip delivery, including non-delivery reasons. Service-role access only.';
