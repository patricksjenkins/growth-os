-- ============================================================================
-- Migration 070: No-touch scheduling control foundation
-- Date: 2026-07-24
--
-- Additive and inactive by default. Existing Calendly and meeting behavior is
-- unchanged until FGA_OS_SCHEDULING_WRITES_ENABLED is explicitly activated.
--
-- ROLLBACK: db/rollbacks/070_scheduling_control_rollback.sql
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.scheduling_policies (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  policy_key               text NOT NULL DEFAULT 'default',
  timezone                 text NOT NULL,
  provider                 text NOT NULL,
  provider_calendar_ref    text,
  availability_rules       jsonb NOT NULL DEFAULT '{}'::jsonb,
  minimum_notice_minutes   integer NOT NULL DEFAULT 120 CHECK (minimum_notice_minutes >= 0),
  buffer_before_minutes    integer NOT NULL DEFAULT 15 CHECK (buffer_before_minutes >= 0),
  buffer_after_minutes     integer NOT NULL DEFAULT 15 CHECK (buffer_after_minutes >= 0),
  maximum_days_ahead       integer NOT NULL DEFAULT 45 CHECK (maximum_days_ahead BETWEEN 1 AND 365),
  reminder_policy          jsonb NOT NULL DEFAULT '{}'::jsonb,
  active                   boolean NOT NULL DEFAULT false,
  created_by               uuid,
  updated_by               uuid,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, policy_key)
);

CREATE TABLE IF NOT EXISTS public.appointment_workflows (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  policy_id                uuid REFERENCES public.scheduling_policies(id) ON DELETE SET NULL,
  lead_id                  uuid REFERENCES public.leads(id) ON DELETE SET NULL,
  customer_id              uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  owner_user_id            uuid,
  appointment_type         text NOT NULL,
  status                   text NOT NULL DEFAULT 'needed'
                             CHECK (status IN (
                               'needed', 'invitation_ready', 'invited', 'scheduled',
                               'prepared', 'completed', 'no_show', 'cancelled',
                               'reschedule_needed', 'failed'
                             )),
  provider                 text,
  provider_event_id        text,
  provider_booking_url     text,
  scheduled_start          timestamptz,
  scheduled_end            timestamptz,
  attendee_timezone        text,
  preparation_document_id  uuid REFERENCES public.documents(id) ON DELETE SET NULL,
  outcome_code             text,
  follow_up_due_at         timestamptz,
  exception_reason         text,
  idempotency_key          text NOT NULL,
  created_by               uuid,
  updated_by               uuid,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key),
  CHECK (
    (scheduled_start IS NULL AND scheduled_end IS NULL)
    OR (
      scheduled_start IS NOT NULL
      AND scheduled_end IS NOT NULL
      AND scheduled_end > scheduled_start
    )
  ),
  CHECK (
    status NOT IN ('scheduled', 'prepared', 'completed', 'no_show')
    OR (scheduled_start IS NOT NULL AND scheduled_end IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS public.appointment_events (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  appointment_id           uuid NOT NULL REFERENCES public.appointment_workflows(id) ON DELETE CASCADE,
  event_type               text NOT NULL,
  previous_status          text,
  next_status              text,
  provider_event_id        text,
  actor_type               text NOT NULL DEFAULT 'system',
  actor_id                 uuid,
  evidence                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key          text NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_appointment_workflows_tenant_status
  ON public.appointment_workflows (tenant_id, status, scheduled_start);
CREATE INDEX IF NOT EXISTS idx_appointment_workflows_lead
  ON public.appointment_workflows (tenant_id, lead_id, created_at DESC)
  WHERE lead_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_appointment_provider_event
  ON public.appointment_workflows (tenant_id, provider, provider_event_id)
  WHERE provider IS NOT NULL AND provider_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_appointment_events_workflow
  ON public.appointment_events (tenant_id, appointment_id, created_at);

-- Historical single-column foreign keys prevent orphans, but they do not prove
-- that a referenced record belongs to the same tenant. Enforce that invariant
-- for every scheduling write, including service-role calls that bypass RLS.
CREATE OR REPLACE FUNCTION public.appointment_workflows_tenant_guard()
RETURNS trigger AS $$
BEGIN
  IF NEW.policy_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.scheduling_policies
     WHERE id = NEW.policy_id AND tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'appointment policy tenant mismatch';
  END IF;

  IF NEW.lead_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.leads
     WHERE id = NEW.lead_id AND tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'appointment lead tenant mismatch';
  END IF;

  IF NEW.customer_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.customers
     WHERE id = NEW.customer_id AND tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'appointment customer tenant mismatch';
  END IF;

  IF NEW.preparation_document_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.documents
     WHERE id = NEW.preparation_document_id AND tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'appointment document tenant mismatch';
  END IF;

  IF NEW.owner_user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.tenant_users
     WHERE user_id = NEW.owner_user_id AND tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'appointment owner tenant mismatch';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_appointment_workflows_tenant_guard
  ON public.appointment_workflows;
CREATE TRIGGER trg_appointment_workflows_tenant_guard
  BEFORE INSERT OR UPDATE ON public.appointment_workflows
  FOR EACH ROW EXECUTE FUNCTION public.appointment_workflows_tenant_guard();

CREATE OR REPLACE FUNCTION public.appointment_events_tenant_guard()
RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.appointment_workflows
     WHERE id = NEW.appointment_id AND tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'appointment event tenant mismatch';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_appointment_events_tenant_guard
  ON public.appointment_events;
CREATE TRIGGER trg_appointment_events_tenant_guard
  BEFORE INSERT OR UPDATE ON public.appointment_events
  FOR EACH ROW EXECUTE FUNCTION public.appointment_events_tenant_guard();

ALTER TABLE public.scheduling_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.appointment_workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.appointment_events ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'scheduling_policies',
    'appointment_workflows',
    'appointment_events'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM pg_policies
       WHERE schemaname = 'public'
         AND tablename = table_name
         AND policyname = 'tenant_iso_' || table_name
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated ' ||
        'USING (' ||
          'tenant_id = NULLIF(auth.jwt()->''app_metadata''->>''tenant_id'', '''')::uuid ' ||
          'AND auth.jwt()->''app_metadata''->>''role'' ' ||
            'IN (''owner'', ''platform_owner'', ''founder'', ''admin'')' ||
        ')',
        'tenant_iso_' || table_name,
        table_name
      );
    END IF;
  END LOOP;
END $$;
