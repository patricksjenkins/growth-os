-- 106: Canonical, evidence-backed Growth Engine pipeline.
--
-- Additive only. Existing customer and outreach tables remain unchanged.
-- The new ledger is tenant-scoped, append-only, and contains no message body,
-- recipient address, or customer payload. Existing tables continue serving
-- legacy APIs while projections move to this source of truth.

CREATE TABLE IF NOT EXISTS public.growth_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  lead_id uuid REFERENCES public.leads(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  stage text CHECK (stage IS NULL OR stage IN (
    'discovered', 'contact_verified', 'qualified', 'drafted',
    'provider_accepted', 'delivered', 'human_reply', 'warm',
    'owner_accepted', 'demo_held', 'proposal', 'won'
  )),
  source_system text NOT NULL,
  source_id text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL DEFAULT 'system',
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  experiment_key text,
  icp_version text,
  score_version text,
  message_version text,
  correlation_id text,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_growth_events_tenant_time
  ON public.growth_events (tenant_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_growth_events_tenant_stage_time
  ON public.growth_events (tenant_id, stage, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_growth_events_lead_time
  ON public.growth_events (tenant_id, lead_id, occurred_at ASC);

CREATE TABLE IF NOT EXISTS public.growth_stage_state (
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  stage text NOT NULL CHECK (stage IN (
    'discovered', 'contact_verified', 'qualified', 'drafted',
    'provider_accepted', 'delivered', 'human_reply', 'warm',
    'owner_accepted', 'demo_held', 'proposal', 'won'
  )),
  stage_entered_at timestamptz NOT NULL,
  last_event_id uuid NOT NULL REFERENCES public.growth_events(id),
  evidence_status text NOT NULL DEFAULT 'verified'
    CHECK (evidence_status IN ('verified', 'incomplete', 'unavailable')),
  blocked_reason text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, lead_id)
);

CREATE INDEX IF NOT EXISTS idx_growth_stage_state_tenant_stage
  ON public.growth_stage_state (tenant_id, stage, stage_entered_at DESC);

CREATE OR REPLACE FUNCTION public.growth_stage_rank(value text)
RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE value
    WHEN 'discovered' THEN 10 WHEN 'contact_verified' THEN 20
    WHEN 'qualified' THEN 30 WHEN 'drafted' THEN 40
    WHEN 'provider_accepted' THEN 50 WHEN 'delivered' THEN 60
    WHEN 'human_reply' THEN 70 WHEN 'warm' THEN 80
    WHEN 'owner_accepted' THEN 90 WHEN 'demo_held' THEN 100
    WHEN 'proposal' THEN 110 WHEN 'won' THEN 120 ELSE 0 END;
$$;

CREATE OR REPLACE FUNCTION public.project_growth_stage_event()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.lead_id IS NULL OR NEW.stage IS NULL THEN RETURN NEW; END IF;
  INSERT INTO public.growth_stage_state (
    tenant_id, lead_id, stage, stage_entered_at, last_event_id,
    evidence_status, blocked_reason, updated_at
  ) VALUES (
    NEW.tenant_id, NEW.lead_id, NEW.stage, NEW.occurred_at, NEW.id,
    CASE WHEN NEW.evidence = '{}'::jsonb THEN 'incomplete' ELSE 'verified' END,
    NULL, now()
  )
  ON CONFLICT (tenant_id, lead_id) DO UPDATE SET
    stage = EXCLUDED.stage,
    stage_entered_at = EXCLUDED.stage_entered_at,
    last_event_id = EXCLUDED.last_event_id,
    evidence_status = EXCLUDED.evidence_status,
    blocked_reason = NULL,
    updated_at = now()
  WHERE public.growth_stage_rank(EXCLUDED.stage)
    >= public.growth_stage_rank(public.growth_stage_state.stage);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS growth_events_project_stage ON public.growth_events;
CREATE TRIGGER growth_events_project_stage
  AFTER INSERT ON public.growth_events
  FOR EACH ROW EXECUTE FUNCTION public.project_growth_stage_event();

CREATE TABLE IF NOT EXISTS public.growth_restart_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'validated', 'applying', 'completed', 'cancelled', 'failed')),
  policy_version text NOT NULL,
  sequence_plan_key text NOT NULL,
  dry_run_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  applied_summary jsonb,
  created_by text NOT NULL DEFAULT 'codex',
  created_at timestamptz NOT NULL DEFAULT now(),
  validated_at timestamptz,
  applied_at timestamptz
);

CREATE TABLE IF NOT EXISTS public.growth_restart_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES public.growth_restart_batches(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  decision text NOT NULL CHECK (decision IN ('eligible', 'needs_evidence', 'excluded')),
  reason text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  applied_enrollment_id uuid REFERENCES public.drip_enrollments(id) ON DELETE SET NULL,
  authorized_at timestamptz,
  first_touch_sequence_id uuid REFERENCES public.outreach_sequences(id) ON DELETE SET NULL,
  first_touch_sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  UNIQUE (batch_id, lead_id)
);

CREATE INDEX IF NOT EXISTS idx_growth_restart_candidates_decision
  ON public.growth_restart_candidates (batch_id, decision, reason);

-- Foreign keys prove that a record exists; these triggers also prove that it
-- belongs to the SAME tenant. Service-role writes bypass RLS, so tenant
-- reference integrity must be enforced inside the database as well as code.
CREATE OR REPLACE FUNCTION public.assert_growth_lead_tenant()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.lead_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.leads l
    WHERE l.id = NEW.lead_id AND l.tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'growth lead tenant mismatch'
      USING errcode = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.assert_growth_stage_event_tenant()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.growth_events e
    WHERE e.id = NEW.last_event_id
      AND e.tenant_id = NEW.tenant_id
      AND e.lead_id = NEW.lead_id
  ) THEN
    RAISE EXCEPTION 'growth stage event tenant or lead mismatch'
      USING errcode = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.assert_growth_restart_tenant_refs()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.growth_restart_batches b
    WHERE b.id = NEW.batch_id AND b.tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'growth restart batch tenant mismatch'
      USING errcode = '23514';
  END IF;
  IF NEW.applied_enrollment_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.drip_enrollments d
    WHERE d.id = NEW.applied_enrollment_id AND d.tenant_id = NEW.tenant_id
      AND d.lead_id = NEW.lead_id
  ) THEN
    RAISE EXCEPTION 'growth restart enrollment tenant or lead mismatch'
      USING errcode = '23514';
  END IF;
  IF NEW.first_touch_sequence_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.outreach_sequences s
    WHERE s.id = NEW.first_touch_sequence_id AND s.tenant_id = NEW.tenant_id
      AND s.lead_id = NEW.lead_id
  ) THEN
    RAISE EXCEPTION 'growth restart sequence tenant or lead mismatch'
      USING errcode = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS growth_events_tenant_refs ON public.growth_events;
CREATE TRIGGER growth_events_tenant_refs
  BEFORE INSERT ON public.growth_events
  FOR EACH ROW EXECUTE FUNCTION public.assert_growth_lead_tenant();

DROP TRIGGER IF EXISTS growth_stage_lead_tenant ON public.growth_stage_state;
CREATE TRIGGER growth_stage_lead_tenant
  BEFORE INSERT OR UPDATE ON public.growth_stage_state
  FOR EACH ROW EXECUTE FUNCTION public.assert_growth_lead_tenant();

DROP TRIGGER IF EXISTS growth_stage_event_tenant ON public.growth_stage_state;
CREATE TRIGGER growth_stage_event_tenant
  BEFORE INSERT OR UPDATE ON public.growth_stage_state
  FOR EACH ROW EXECUTE FUNCTION public.assert_growth_stage_event_tenant();

DROP TRIGGER IF EXISTS growth_restart_candidate_lead_tenant ON public.growth_restart_candidates;
CREATE TRIGGER growth_restart_candidate_lead_tenant
  BEFORE INSERT OR UPDATE ON public.growth_restart_candidates
  FOR EACH ROW EXECUTE FUNCTION public.assert_growth_lead_tenant();

DROP TRIGGER IF EXISTS growth_restart_candidate_refs ON public.growth_restart_candidates;
CREATE TRIGGER growth_restart_candidate_refs
  BEFORE INSERT OR UPDATE ON public.growth_restart_candidates
  FOR EACH ROW EXECUTE FUNCTION public.assert_growth_restart_tenant_refs();

ALTER TABLE public.drip_campaigns
  ADD COLUMN IF NOT EXISTS plan_key text NOT NULL DEFAULT 'legacy-nine-followups-v1',
  ADD COLUMN IF NOT EXISTS total_touches integer,
  ADD COLUMN IF NOT EXISTS includes_initial_touch boolean NOT NULL DEFAULT true;

ALTER TABLE public.email_events
  ADD COLUMN IF NOT EXISTS provider_event_id text;
CREATE UNIQUE INDEX IF NOT EXISTS uq_email_events_provider_event
  ON public.email_events (provider, provider_event_id)
  WHERE provider_event_id IS NOT NULL;

ALTER TABLE public.drip_inbound
  ADD COLUMN IF NOT EXISTS body_text text,
  ADD COLUMN IF NOT EXISTS intent text,
  ADD COLUMN IF NOT EXISTS routed_at timestamptz;

ALTER TABLE public.email_connections
  ADD COLUMN IF NOT EXISTS reply_cursor_at timestamptz;

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS growth_evidence_status text
    CHECK (growth_evidence_status IS NULL OR growth_evidence_status IN (
      'pending', 'complete', 'contact_only', 'employee_only', 'incomplete', 'failed'
    )),
  ADD COLUMN IF NOT EXISTS growth_evidence_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS growth_evidence_attempts integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_leads_fga_growth_evidence_queue
  ON public.leads (tenant_id, growth_evidence_attempts, growth_evidence_status, created_at)
  WHERE growth_evidence_attempts < 5
    AND (growth_evidence_status IS NULL OR growth_evidence_status IN (
      'pending', 'failed', 'incomplete', 'contact_only', 'employee_only'
    ));

ALTER TABLE public.growth_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.growth_stage_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.growth_restart_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.growth_restart_candidates ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'growth_events', 'growth_stage_state', 'growth_restart_batches', 'growth_restart_candidates'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = table_name
        AND policyname = 'tenant_read_' || table_name
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR SELECT USING (auth.role() = ''service_role'' OR tenant_id = nullif(auth.jwt() -> ''app_metadata'' ->> ''tenant_id'', '''')::uuid)',
        'tenant_read_' || table_name, table_name
      );
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = table_name
        AND policyname = 'service_write_' || table_name
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR ALL USING (auth.role() = ''service_role'') WITH CHECK (auth.role() = ''service_role'')',
        'service_write_' || table_name, table_name
      );
    END IF;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.growth_events_block_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'growth_events is append-only: % is not allowed', TG_OP
    USING errcode = '42501';
END;
$$;

DROP TRIGGER IF EXISTS growth_events_append_only ON public.growth_events;
CREATE TRIGGER growth_events_append_only
  BEFORE UPDATE OR DELETE ON public.growth_events
  FOR EACH ROW EXECUTE FUNCTION public.growth_events_block_mutation();

COMMENT ON TABLE public.growth_events IS
  'Append-only, tenant-scoped evidence ledger for movement through the prospect-to-customer pipeline.';
COMMENT ON TABLE public.growth_restart_batches IS
  'Guarded FGA prospect re-enrollment manifests. Creating a manifest never sends or changes a lead.';
