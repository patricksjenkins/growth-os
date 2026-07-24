-- ============================================================================
-- Migration 076: Closed-won -> acknowledged onboarding handoff foundation
-- Date: 2026-07-24
--
-- This migration is additive and inert by default. It does not alter leads,
-- customers, tenants, onboarding workflows, or any existing route. The only
-- command boundary is a service-role-only SECURITY DEFINER RPC with an explicit
-- caller-provided feature gate that defaults false.
--
-- Identity model (based on the deployed schema):
--   * public.leads.status = 'won' is sales outcome truth.
--   * an optional public.customers record must belong to the lead's source
--     tenant; it is never inferred by name, email, or phone.
--   * public.onboarding_workflows belongs to the newly provisioned client
--     tenant, which may differ from the FGA sales/source tenant.
--   * the source and client tenant IDs are stored separately and verified.
--
-- No external messages, provisioning, charges, or production activation occur
-- in this migration. It records a supervised handoff and immutable evidence.
--
-- ROLLBACK:
--   db/rollbacks/076_closed_won_onboarding_handoff_rollback.sql
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.sales_closed_won_events (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_tenant_id      uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  lead_id               uuid NOT NULL REFERENCES public.leads(id) ON DELETE RESTRICT,
  customer_id           uuid REFERENCES public.customers(id) ON DELETE RESTRICT,
  client_tenant_id      uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  source_event_key      text NOT NULL CHECK (char_length(source_event_key) BETWEEN 8 AND 200),
  closed_won_at         timestamptz NOT NULL,
  lead_status_snapshot  text NOT NULL CHECK (lead_status_snapshot = 'won'),
  request_fingerprint   text NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  recorded_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_tenant_id, source_event_key),
  UNIQUE (id, source_tenant_id)
);

CREATE TABLE IF NOT EXISTS public.closed_won_onboarding_handoffs (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_tenant_id         uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  client_tenant_id         uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  closed_won_event_id      uuid NOT NULL,
  lead_id                  uuid NOT NULL REFERENCES public.leads(id) ON DELETE RESTRICT,
  customer_id              uuid REFERENCES public.customers(id) ON DELETE RESTRICT,
  onboarding_workflow_id   uuid REFERENCES public.onboarding_workflows(id) ON DELETE RESTRICT,
  state                    text NOT NULL DEFAULT 'pending_acceptance'
    CHECK (state IN (
      'pending_acceptance', 'accepted', 'acknowledged', 'exception', 'completed'
    )),
  acceptance_state         text NOT NULL DEFAULT 'pending'
    CHECK (acceptance_state IN ('pending', 'accepted')),
  acknowledgment_state     text NOT NULL DEFAULT 'pending'
    CHECK (acknowledgment_state IN ('pending', 'acknowledged')),
  sla_state                text NOT NULL DEFAULT 'open'
    CHECK (sla_state IN ('open', 'met', 'breached')),
  retry_state              text NOT NULL DEFAULT 'not_scheduled'
    CHECK (retry_state IN ('not_scheduled', 'scheduled', 'exhausted')),
  evidence_state           text NOT NULL DEFAULT 'closed_won_only'
    CHECK (evidence_state IN (
      'closed_won_only', 'acceptance_recorded', 'acknowledgment_proven',
      'completion_proven', 'exception_recorded'
    )),
  attempt_count            integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  revision                 integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  accept_by                timestamptz NOT NULL,
  acknowledge_by           timestamptz NOT NULL,
  accepted_at              timestamptz,
  acknowledged_at          timestamptz,
  completed_at             timestamptz,
  last_attempt_at          timestamptz,
  next_retry_at            timestamptz,
  exception_code           text,
  exception_raised_at      timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT closed_won_handoff_event_tenant_fk
    FOREIGN KEY (closed_won_event_id, source_tenant_id)
    REFERENCES public.sales_closed_won_events(id, source_tenant_id)
    ON DELETE RESTRICT,
  CONSTRAINT closed_won_handoff_deadline_order
    CHECK (acknowledge_by >= accept_by),
  CONSTRAINT closed_won_handoff_acceptance_consistency
    CHECK (
      (acceptance_state = 'pending' AND accepted_at IS NULL)
      OR
      (acceptance_state = 'accepted' AND accepted_at IS NOT NULL)
    ),
  CONSTRAINT closed_won_handoff_ack_consistency
    CHECK (
      (acknowledgment_state = 'pending' AND acknowledged_at IS NULL)
      OR
      (
        acknowledgment_state = 'acknowledged'
        AND acknowledged_at IS NOT NULL
        AND onboarding_workflow_id IS NOT NULL
      )
    ),
  CONSTRAINT closed_won_handoff_completion_consistency
    CHECK (
      (state <> 'completed' AND completed_at IS NULL)
      OR
      (
        state = 'completed'
        AND completed_at IS NOT NULL
        AND acknowledgment_state = 'acknowledged'
      )
    ),
  CONSTRAINT closed_won_handoff_exception_consistency
    CHECK (
      (state <> 'exception' AND exception_code IS NULL)
      OR
      (
        state = 'exception'
        AND exception_code ~ '^[a-z][a-z0-9_]{2,79}$'
        AND exception_raised_at IS NOT NULL
      )
    ),
  UNIQUE (closed_won_event_id),
  UNIQUE (id, source_tenant_id)
);

CREATE TABLE IF NOT EXISTS public.closed_won_onboarding_events (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_tenant_id      uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  handoff_id            uuid NOT NULL,
  event_type            text NOT NULL
    CHECK (event_type IN (
      'initiated', 'accepted', 'acknowledged', 'retry_scheduled',
      'retry_exhausted', 'exception_raised', 'completed'
    )),
  from_state            text,
  to_state              text NOT NULL,
  actor_type            text NOT NULL CHECK (actor_type IN ('human', 'service', 'system')),
  actor_id              text,
  reason_code           text,
  idempotency_key       text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  request_fingerprint   text NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  evidence_type         text,
  evidence_id           text,
  evidence_digest       text CHECK (evidence_digest IS NULL OR evidence_digest ~ '^[a-f0-9]{64}$'),
  evidence_observed_at  timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT closed_won_event_handoff_tenant_fk
    FOREIGN KEY (handoff_id, source_tenant_id)
    REFERENCES public.closed_won_onboarding_handoffs(id, source_tenant_id)
    ON DELETE RESTRICT,
  CONSTRAINT closed_won_event_actor_consistency
    CHECK (
      (actor_type = 'system' AND actor_id IS NULL)
      OR
      (actor_type <> 'system' AND NULLIF(btrim(actor_id), '') IS NOT NULL)
    ),
  CONSTRAINT closed_won_event_evidence_consistency
    CHECK (
      (
        event_type = 'initiated'
        AND evidence_type = 'closed_won_lead'
        AND evidence_id IS NOT NULL
        AND evidence_digest IS NOT NULL
        AND evidence_observed_at IS NOT NULL
      )
      OR
      (
        event_type <> 'initiated'
        AND evidence_type IS NOT NULL
        AND evidence_id IS NOT NULL
        AND evidence_digest IS NOT NULL
        AND evidence_observed_at IS NOT NULL
      )
    ),
  UNIQUE (source_tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_sales_closed_won_events_lead
  ON public.sales_closed_won_events(source_tenant_id, lead_id, closed_won_at DESC);
CREATE INDEX IF NOT EXISTS idx_closed_won_handoffs_state
  ON public.closed_won_onboarding_handoffs(source_tenant_id, state, acknowledge_by);
CREATE INDEX IF NOT EXISTS idx_closed_won_handoffs_client
  ON public.closed_won_onboarding_handoffs(client_tenant_id, onboarding_workflow_id);
CREATE INDEX IF NOT EXISTS idx_closed_won_handoffs_retry
  ON public.closed_won_onboarding_handoffs(source_tenant_id, next_retry_at)
  WHERE retry_state = 'scheduled';
CREATE INDEX IF NOT EXISTS idx_closed_won_onboarding_events_handoff
  ON public.closed_won_onboarding_events(source_tenant_id, handoff_id, created_at);

CREATE OR REPLACE FUNCTION public.closed_won_onboarding_immutable_row()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'closed_won_onboarding_evidence_is_immutable';
END;
$$;

DROP TRIGGER IF EXISTS trg_sales_closed_won_events_immutable
  ON public.sales_closed_won_events;
CREATE TRIGGER trg_sales_closed_won_events_immutable
  BEFORE UPDATE OR DELETE ON public.sales_closed_won_events
  FOR EACH ROW EXECUTE FUNCTION public.closed_won_onboarding_immutable_row();

DROP TRIGGER IF EXISTS trg_closed_won_onboarding_events_immutable
  ON public.closed_won_onboarding_events;
CREATE TRIGGER trg_closed_won_onboarding_events_immutable
  BEFORE UPDATE OR DELETE ON public.closed_won_onboarding_events
  FOR EACH ROW EXECUTE FUNCTION public.closed_won_onboarding_immutable_row();

CREATE OR REPLACE FUNCTION public.validate_closed_won_onboarding_handoff()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_closed_event public.sales_closed_won_events%ROWTYPE;
BEGIN
  SELECT event.*
    INTO STRICT v_closed_event
    FROM public.sales_closed_won_events event
   WHERE event.id = NEW.closed_won_event_id
     AND event.source_tenant_id = NEW.source_tenant_id;

  IF NEW.lead_id IS DISTINCT FROM v_closed_event.lead_id
     OR NEW.customer_id IS DISTINCT FROM v_closed_event.customer_id
     OR NEW.client_tenant_id IS DISTINCT FROM v_closed_event.client_tenant_id THEN
    RAISE EXCEPTION 'closed_won_handoff_identity_mismatch';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.source_tenant_id IS DISTINCT FROM OLD.source_tenant_id
       OR NEW.client_tenant_id IS DISTINCT FROM OLD.client_tenant_id
       OR NEW.closed_won_event_id IS DISTINCT FROM OLD.closed_won_event_id
       OR NEW.lead_id IS DISTINCT FROM OLD.lead_id
       OR NEW.customer_id IS DISTINCT FROM OLD.customer_id THEN
      RAISE EXCEPTION 'closed_won_handoff_identity_is_immutable';
    END IF;
  END IF;

  -- Verify live source truth when the immutable handoff is captured. Later
  -- transitions must not freeze merely because the source lead advances past
  -- `won` or the client tenant changes operational status.
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1
        FROM public.leads lead
       WHERE lead.id = NEW.lead_id
         AND lead.tenant_id = NEW.source_tenant_id
         AND lead.status = 'won'
    ) THEN
      RAISE EXCEPTION 'closed_won_lead_not_authoritative';
    END IF;

    IF NEW.customer_id IS NOT NULL AND NOT EXISTS (
      SELECT 1
        FROM public.customers customer
       WHERE customer.id = NEW.customer_id
         AND customer.tenant_id = NEW.source_tenant_id
    ) THEN
      RAISE EXCEPTION 'closed_won_customer_tenant_mismatch';
    END IF;

    IF NOT EXISTS (
      SELECT 1
        FROM public.tenants client
       WHERE client.id = NEW.client_tenant_id
         AND client.status = 'active'
    ) THEN
      RAISE EXCEPTION 'closed_won_client_tenant_not_active';
    END IF;
  END IF;

  IF NEW.onboarding_workflow_id IS NOT NULL THEN
    IF TG_OP = 'INSERT' THEN
      IF NOT EXISTS (
        SELECT 1
          FROM public.onboarding_workflows workflow
         WHERE workflow.id = NEW.onboarding_workflow_id
           AND workflow.tenant_id = NEW.client_tenant_id
      ) THEN
        RAISE EXCEPTION 'onboarding_workflow_client_tenant_mismatch';
      END IF;
    ELSIF NEW.onboarding_workflow_id IS DISTINCT FROM OLD.onboarding_workflow_id THEN
      IF NOT EXISTS (
        SELECT 1
          FROM public.onboarding_workflows workflow
         WHERE workflow.id = NEW.onboarding_workflow_id
           AND workflow.tenant_id = NEW.client_tenant_id
      ) THEN
        RAISE EXCEPTION 'onboarding_workflow_client_tenant_mismatch';
      END IF;
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    NEW.revision := OLD.revision + 1;
    NEW.updated_at := now();
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_closed_won_onboarding_handoff
  ON public.closed_won_onboarding_handoffs;
CREATE TRIGGER trg_validate_closed_won_onboarding_handoff
  BEFORE INSERT OR UPDATE ON public.closed_won_onboarding_handoffs
  FOR EACH ROW EXECUTE FUNCTION public.validate_closed_won_onboarding_handoff();

ALTER TABLE public.sales_closed_won_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.closed_won_onboarding_handoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.closed_won_onboarding_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON
  public.sales_closed_won_events,
  public.closed_won_onboarding_handoffs,
  public.closed_won_onboarding_events
FROM PUBLIC, anon, authenticated;

GRANT SELECT ON
  public.sales_closed_won_events,
  public.closed_won_onboarding_handoffs,
  public.closed_won_onboarding_events
TO service_role;

REVOKE INSERT, UPDATE, DELETE ON
  public.sales_closed_won_events,
  public.closed_won_onboarding_handoffs,
  public.closed_won_onboarding_events
FROM service_role;

CREATE OR REPLACE FUNCTION public.closed_won_onboarding_handoff_rpc(
  p_action text,
  p_source_tenant_id uuid,
  p_idempotency_key text,
  p_request_fingerprint text,
  p_actor_type text,
  p_actor_id text DEFAULT NULL,
  p_handoff_id uuid DEFAULT NULL,
  p_expected_revision integer DEFAULT NULL,
  p_lead_id uuid DEFAULT NULL,
  p_customer_id uuid DEFAULT NULL,
  p_client_tenant_id uuid DEFAULT NULL,
  p_onboarding_workflow_id uuid DEFAULT NULL,
  p_source_event_key text DEFAULT NULL,
  p_closed_won_at timestamptz DEFAULT NULL,
  p_accept_by timestamptz DEFAULT NULL,
  p_acknowledge_by timestamptz DEFAULT NULL,
  p_retry_at timestamptz DEFAULT NULL,
  p_max_attempts integer DEFAULT 5,
  p_exception_code text DEFAULT NULL,
  p_reason_code text DEFAULT NULL,
  p_evidence_type text DEFAULT NULL,
  p_evidence_id text DEFAULT NULL,
  p_evidence_digest text DEFAULT NULL,
  p_evidence_observed_at timestamptz DEFAULT NULL,
  p_feature_gate_enabled boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_claims text;
  v_calling_role text;
  v_action text;
  v_existing_event public.closed_won_onboarding_events%ROWTYPE;
  v_event public.closed_won_onboarding_events%ROWTYPE;
  v_closed_event public.sales_closed_won_events%ROWTYPE;
  v_handoff public.closed_won_onboarding_handoffs%ROWTYPE;
  v_from_state text;
  v_event_type text;
  v_next_attempt integer;
BEGIN
  v_claims := NULLIF(current_setting('request.jwt.claims', true), '');
  v_calling_role := COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    CASE WHEN v_claims IS NOT NULL THEN v_claims::jsonb ->> 'role' END,
    session_user::text
  );
  IF v_calling_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'closed_won_onboarding_requires_service_role';
  END IF;
  IF p_feature_gate_enabled IS DISTINCT FROM true THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'closed_won_onboarding_handoff_disabled';
  END IF;

  v_action := lower(NULLIF(btrim(p_action), ''));
  IF v_action IS NULL OR v_action NOT IN (
    'initiate', 'accept', 'acknowledge', 'record_retry',
    'raise_exception', 'complete'
  ) THEN
    RAISE EXCEPTION 'invalid_closed_won_onboarding_action';
  END IF;
  IF p_source_tenant_id IS NULL THEN
    RAISE EXCEPTION 'source_tenant_id_required';
  END IF;
  IF p_actor_type IS NULL OR p_actor_type NOT IN ('human', 'service', 'system') THEN
    RAISE EXCEPTION 'invalid_closed_won_onboarding_actor_type';
  END IF;
  IF p_actor_type <> 'system' AND NULLIF(btrim(p_actor_id), '') IS NULL THEN
    RAISE EXCEPTION 'closed_won_onboarding_actor_id_required';
  END IF;
  IF p_actor_type = 'system' AND NULLIF(btrim(p_actor_id), '') IS NOT NULL THEN
    RAISE EXCEPTION 'system_actor_id_must_be_null';
  END IF;
  IF p_actor_type = 'human' THEN
    IF p_actor_id !~
      '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' THEN
      RAISE EXCEPTION 'closed_won_onboarding_human_actor_invalid';
    END IF;
    IF NOT EXISTS (
      SELECT 1
        FROM public.tenant_users tenant_user
       WHERE tenant_user.tenant_id = p_source_tenant_id
         AND tenant_user.user_id = p_actor_id::uuid
         AND tenant_user.role IN (
           'owner', 'platform_owner', 'founder', 'admin',
           'client_owner', 'tenant_owner'
         )
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'closed_won_onboarding_human_actor_not_source_tenant_owner';
    END IF;
  END IF;
  IF p_idempotency_key IS NULL
     OR char_length(p_idempotency_key) NOT BETWEEN 8 AND 200 THEN
    RAISE EXCEPTION 'invalid_closed_won_onboarding_idempotency_key';
  END IF;
  IF p_request_fingerprint IS NULL
     OR p_request_fingerprint !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'invalid_closed_won_onboarding_request_fingerprint';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_source_tenant_id::text || ':' || p_idempotency_key, 0)
  );

  SELECT event.*
    INTO v_existing_event
    FROM public.closed_won_onboarding_events event
   WHERE event.source_tenant_id = p_source_tenant_id
     AND event.idempotency_key = p_idempotency_key;

  IF FOUND THEN
    v_event_type := CASE v_action
      WHEN 'initiate' THEN 'initiated'
      WHEN 'accept' THEN 'accepted'
      WHEN 'acknowledge' THEN 'acknowledged'
      WHEN 'record_retry' THEN
        CASE WHEN v_existing_event.event_type = 'retry_exhausted'
          THEN 'retry_exhausted' ELSE 'retry_scheduled' END
      WHEN 'raise_exception' THEN 'exception_raised'
      WHEN 'complete' THEN 'completed'
    END;
    IF v_existing_event.event_type IS DISTINCT FROM v_event_type
       OR v_existing_event.request_fingerprint IS DISTINCT FROM p_request_fingerprint THEN
      RAISE EXCEPTION USING
        ERRCODE = '23505',
        MESSAGE = 'closed_won_onboarding_idempotency_conflict';
    END IF;

    SELECT handoff.*
      INTO STRICT v_handoff
      FROM public.closed_won_onboarding_handoffs handoff
     WHERE handoff.id = v_existing_event.handoff_id
       AND handoff.source_tenant_id = p_source_tenant_id;

    RETURN jsonb_build_object(
      'outcome', 'replay',
      'handoff', to_jsonb(v_handoff),
      'event', to_jsonb(v_existing_event)
    );
  END IF;

  IF v_action = 'initiate' THEN
    IF p_lead_id IS NULL OR p_client_tenant_id IS NULL
       OR p_closed_won_at IS NULL OR p_accept_by IS NULL
       OR p_acknowledge_by IS NULL THEN
      RAISE EXCEPTION 'closed_won_initiation_identity_and_sla_required';
    END IF;
    IF p_source_event_key IS NULL
       OR char_length(p_source_event_key) NOT BETWEEN 8 AND 200 THEN
      RAISE EXCEPTION 'invalid_closed_won_source_event_key';
    END IF;
    IF p_closed_won_at > now() THEN
      RAISE EXCEPTION 'closed_won_at_cannot_be_future';
    END IF;
    IF p_accept_by <= p_closed_won_at OR p_acknowledge_by < p_accept_by THEN
      RAISE EXCEPTION 'invalid_closed_won_handoff_sla_order';
    END IF;

    PERFORM 1
      FROM public.leads lead
     WHERE lead.id = p_lead_id
       AND lead.tenant_id = p_source_tenant_id
       AND lead.status = 'won'
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'closed_won_lead_not_authoritative';
    END IF;

    IF p_customer_id IS NOT NULL THEN
      PERFORM 1
        FROM public.customers customer
       WHERE customer.id = p_customer_id
         AND customer.tenant_id = p_source_tenant_id
       FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'closed_won_customer_tenant_mismatch';
      END IF;
    END IF;

    PERFORM 1
      FROM public.tenants client
     WHERE client.id = p_client_tenant_id
       AND client.status = 'active'
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'closed_won_client_tenant_not_active';
    END IF;

    IF p_onboarding_workflow_id IS NOT NULL THEN
      PERFORM 1
        FROM public.onboarding_workflows workflow
       WHERE workflow.id = p_onboarding_workflow_id
         AND workflow.tenant_id = p_client_tenant_id
       FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'onboarding_workflow_client_tenant_mismatch';
      END IF;
    END IF;

    PERFORM pg_advisory_xact_lock(
      hashtextextended(
        p_source_tenant_id::text || ':closed-won:' || p_source_event_key,
        0
      )
    );

    SELECT event.*
      INTO v_closed_event
      FROM public.sales_closed_won_events event
     WHERE event.source_tenant_id = p_source_tenant_id
       AND event.source_event_key = p_source_event_key;

    IF FOUND THEN
      IF v_closed_event.lead_id IS DISTINCT FROM p_lead_id
         OR v_closed_event.customer_id IS DISTINCT FROM p_customer_id
         OR v_closed_event.client_tenant_id IS DISTINCT FROM p_client_tenant_id
         OR v_closed_event.closed_won_at IS DISTINCT FROM p_closed_won_at
         OR v_closed_event.request_fingerprint IS DISTINCT FROM p_request_fingerprint THEN
        RAISE EXCEPTION USING
          ERRCODE = '23505',
          MESSAGE = 'closed_won_source_event_conflict';
      END IF;

      SELECT handoff.*
        INTO STRICT v_handoff
        FROM public.closed_won_onboarding_handoffs handoff
       WHERE handoff.closed_won_event_id = v_closed_event.id;

      SELECT event.*
        INTO STRICT v_event
        FROM public.closed_won_onboarding_events event
       WHERE event.handoff_id = v_handoff.id
         AND event.event_type = 'initiated';

      RETURN jsonb_build_object(
        'outcome', 'replay',
        'handoff', to_jsonb(v_handoff),
        'event', to_jsonb(v_event)
      );
    END IF;

    INSERT INTO public.sales_closed_won_events (
      source_tenant_id,
      lead_id,
      customer_id,
      client_tenant_id,
      source_event_key,
      closed_won_at,
      lead_status_snapshot,
      request_fingerprint
    ) VALUES (
      p_source_tenant_id,
      p_lead_id,
      p_customer_id,
      p_client_tenant_id,
      p_source_event_key,
      p_closed_won_at,
      'won',
      p_request_fingerprint
    )
    RETURNING * INTO v_closed_event;

    INSERT INTO public.closed_won_onboarding_handoffs (
      source_tenant_id,
      client_tenant_id,
      closed_won_event_id,
      lead_id,
      customer_id,
      onboarding_workflow_id,
      accept_by,
      acknowledge_by
    ) VALUES (
      p_source_tenant_id,
      p_client_tenant_id,
      v_closed_event.id,
      p_lead_id,
      p_customer_id,
      p_onboarding_workflow_id,
      p_accept_by,
      p_acknowledge_by
    )
    RETURNING * INTO v_handoff;

    INSERT INTO public.closed_won_onboarding_events (
      source_tenant_id,
      handoff_id,
      event_type,
      from_state,
      to_state,
      actor_type,
      actor_id,
      reason_code,
      idempotency_key,
      request_fingerprint,
      evidence_type,
      evidence_id,
      evidence_digest,
      evidence_observed_at
    ) VALUES (
      p_source_tenant_id,
      v_handoff.id,
      'initiated',
      NULL,
      'pending_acceptance',
      p_actor_type,
      NULLIF(btrim(p_actor_id), ''),
      'closed_won_recorded',
      p_idempotency_key,
      p_request_fingerprint,
      'closed_won_lead',
      'lead:' || p_lead_id::text,
      p_request_fingerprint,
      p_closed_won_at
    )
    RETURNING * INTO v_event;

    RETURN jsonb_build_object(
      'outcome', 'created',
      'handoff', to_jsonb(v_handoff),
      'event', to_jsonb(v_event)
    );
  END IF;

  IF p_handoff_id IS NULL OR p_expected_revision IS NULL
     OR p_expected_revision < 1 THEN
    RAISE EXCEPTION 'handoff_id_and_positive_expected_revision_required';
  END IF;

  SELECT handoff.*
    INTO STRICT v_handoff
    FROM public.closed_won_onboarding_handoffs handoff
   WHERE handoff.id = p_handoff_id
     AND handoff.source_tenant_id = p_source_tenant_id
   FOR UPDATE;

  IF v_handoff.revision IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'closed_won_onboarding_revision_conflict';
  END IF;
  IF v_handoff.state IN ('completed') THEN
    RAISE EXCEPTION 'closed_won_onboarding_handoff_is_terminal';
  END IF;

  IF p_evidence_type IS NULL OR p_evidence_id IS NULL
     OR p_evidence_digest IS NULL
     OR p_evidence_digest !~ '^[a-f0-9]{64}$'
     OR p_evidence_observed_at IS NULL
     OR p_evidence_observed_at > now() THEN
    RAISE EXCEPTION 'valid_closed_won_onboarding_evidence_required';
  END IF;
  IF p_evidence_observed_at < v_handoff.created_at THEN
    RAISE EXCEPTION 'closed_won_onboarding_evidence_predates_handoff';
  END IF;
  IF p_reason_code IS NULL OR p_reason_code !~ '^[a-z][a-z0-9_]{2,79}$' THEN
    RAISE EXCEPTION 'valid_closed_won_onboarding_reason_required';
  END IF;

  v_from_state := v_handoff.state;

  CASE v_action
    WHEN 'accept' THEN
      IF v_handoff.state <> 'pending_acceptance'
         OR (
           p_actor_type = 'human'
           AND p_evidence_type <> 'owner_acceptance'
         )
         OR (
           p_actor_type = 'service'
           AND p_evidence_type <> 'service_acceptance'
         )
         OR p_actor_type = 'system' THEN
        RAISE EXCEPTION 'closed_won_handoff_not_accept_ready';
      END IF;
      UPDATE public.closed_won_onboarding_handoffs
         SET state = 'accepted',
             acceptance_state = 'accepted',
             accepted_at = now(),
             sla_state = CASE WHEN now() > accept_by THEN 'breached' ELSE 'open' END,
             retry_state = 'not_scheduled',
             next_retry_at = NULL,
             evidence_state = 'acceptance_recorded'
       WHERE id = v_handoff.id
         AND source_tenant_id = p_source_tenant_id
      RETURNING * INTO v_handoff;
      v_event_type := 'accepted';

    WHEN 'acknowledge' THEN
      IF v_handoff.state <> 'accepted'
         OR p_evidence_type <> 'onboarding_workflow'
         OR p_onboarding_workflow_id IS NULL
         OR p_evidence_id IS DISTINCT FROM
           ('onboarding_workflow:' || p_onboarding_workflow_id::text) THEN
        RAISE EXCEPTION 'closed_won_handoff_not_acknowledgment_ready';
      END IF;
      PERFORM 1
        FROM public.onboarding_workflows workflow
       WHERE workflow.id = p_onboarding_workflow_id
         AND workflow.tenant_id = v_handoff.client_tenant_id
       FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'onboarding_workflow_client_tenant_mismatch';
      END IF;
      UPDATE public.closed_won_onboarding_handoffs
         SET state = 'acknowledged',
             onboarding_workflow_id = p_onboarding_workflow_id,
             acknowledgment_state = 'acknowledged',
             acknowledged_at = now(),
             sla_state = CASE WHEN now() > acknowledge_by THEN 'breached' ELSE 'met' END,
             retry_state = 'not_scheduled',
             next_retry_at = NULL,
             exception_code = NULL,
             exception_raised_at = NULL,
             evidence_state = 'acknowledgment_proven'
       WHERE id = v_handoff.id
         AND source_tenant_id = p_source_tenant_id
      RETURNING * INTO v_handoff;
      v_event_type := 'acknowledged';

    WHEN 'record_retry' THEN
      IF v_handoff.state NOT IN ('pending_acceptance', 'accepted', 'exception')
         OR p_evidence_type <> 'retry_attempt'
         OR p_retry_at IS NULL OR p_retry_at <= now()
         OR p_max_attempts NOT BETWEEN 1 AND 20 THEN
        RAISE EXCEPTION 'invalid_closed_won_handoff_retry';
      END IF;
      v_next_attempt := v_handoff.attempt_count + 1;
      IF v_next_attempt >= p_max_attempts THEN
        UPDATE public.closed_won_onboarding_handoffs
           SET state = 'exception',
               attempt_count = v_next_attempt,
               last_attempt_at = now(),
               next_retry_at = NULL,
               retry_state = 'exhausted',
               exception_code = 'retry_exhausted',
               exception_raised_at = now(),
               evidence_state = 'exception_recorded'
         WHERE id = v_handoff.id
           AND source_tenant_id = p_source_tenant_id
        RETURNING * INTO v_handoff;
        v_event_type := 'retry_exhausted';
      ELSE
        UPDATE public.closed_won_onboarding_handoffs
           SET state = CASE
                 WHEN acknowledgment_state = 'acknowledged' THEN 'acknowledged'
                 WHEN acceptance_state = 'accepted' THEN 'accepted'
                 ELSE 'pending_acceptance'
               END,
               attempt_count = v_next_attempt,
               last_attempt_at = now(),
               next_retry_at = p_retry_at,
               retry_state = 'scheduled',
               exception_code = NULL,
               exception_raised_at = NULL,
               evidence_state = CASE
                 WHEN acknowledgment_state = 'acknowledged'
                   THEN 'acknowledgment_proven'
                 WHEN acceptance_state = 'accepted'
                   THEN 'acceptance_recorded'
                 ELSE 'closed_won_only'
               END
         WHERE id = v_handoff.id
           AND source_tenant_id = p_source_tenant_id
        RETURNING * INTO v_handoff;
        v_event_type := 'retry_scheduled';
      END IF;

    WHEN 'raise_exception' THEN
      IF p_evidence_type <> 'exception'
         OR p_exception_code IS NULL
         OR p_exception_code !~ '^[a-z][a-z0-9_]{2,79}$' THEN
        RAISE EXCEPTION 'invalid_closed_won_handoff_exception';
      END IF;
      UPDATE public.closed_won_onboarding_handoffs
         SET state = 'exception',
             retry_state = 'not_scheduled',
             next_retry_at = NULL,
             exception_code = p_exception_code,
             exception_raised_at = now(),
             evidence_state = 'exception_recorded'
       WHERE id = v_handoff.id
         AND source_tenant_id = p_source_tenant_id
      RETURNING * INTO v_handoff;
      v_event_type := 'exception_raised';

    WHEN 'complete' THEN
      IF v_handoff.state <> 'acknowledged'
         OR p_evidence_type <> 'completion' THEN
        RAISE EXCEPTION 'closed_won_handoff_not_completion_ready';
      END IF;
      UPDATE public.closed_won_onboarding_handoffs
         SET state = 'completed',
             completed_at = now(),
             retry_state = 'not_scheduled',
             next_retry_at = NULL,
             evidence_state = 'completion_proven'
       WHERE id = v_handoff.id
         AND source_tenant_id = p_source_tenant_id
      RETURNING * INTO v_handoff;
      v_event_type := 'completed';
  END CASE;

  INSERT INTO public.closed_won_onboarding_events (
    source_tenant_id,
    handoff_id,
    event_type,
    from_state,
    to_state,
    actor_type,
    actor_id,
    reason_code,
    idempotency_key,
    request_fingerprint,
    evidence_type,
    evidence_id,
    evidence_digest,
    evidence_observed_at
  ) VALUES (
    p_source_tenant_id,
    v_handoff.id,
    v_event_type,
    v_from_state,
    v_handoff.state,
    p_actor_type,
    NULLIF(btrim(p_actor_id), ''),
    p_reason_code,
    p_idempotency_key,
    p_request_fingerprint,
    p_evidence_type,
    p_evidence_id,
    lower(p_evidence_digest),
    p_evidence_observed_at
  )
  RETURNING * INTO v_event;

  RETURN jsonb_build_object(
    'outcome', 'applied',
    'handoff', to_jsonb(v_handoff),
    'event', to_jsonb(v_event)
  );
EXCEPTION
  WHEN no_data_found THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'closed_won_onboarding_handoff_not_found_for_tenant';
END;
$$;

REVOKE EXECUTE ON FUNCTION public.closed_won_onboarding_handoff_rpc(
  text, uuid, text, text, text, text, uuid, integer, uuid, uuid, uuid, uuid,
  text, timestamptz, timestamptz, timestamptz, timestamptz, integer, text,
  text, text, text, text, timestamptz, boolean
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.closed_won_onboarding_handoff_rpc(
  text, uuid, text, text, text, text, uuid, integer, uuid, uuid, uuid, uuid,
  text, timestamptz, timestamptz, timestamptz, timestamptz, integer, text,
  text, text, text, text, timestamptz, boolean
) TO service_role;

COMMENT ON TABLE public.sales_closed_won_events IS
  'Immutable, tenant-bound observation that an authoritative lead is won.';
COMMENT ON TABLE public.closed_won_onboarding_handoffs IS
  'Default-off supervised handoff from a source-tenant won lead to a client-tenant onboarding workflow.';
COMMENT ON TABLE public.closed_won_onboarding_events IS
  'Immutable acceptance, acknowledgment, SLA, retry, exception, and completion evidence.';
COMMENT ON FUNCTION public.closed_won_onboarding_handoff_rpc(
  text, uuid, text, text, text, text, uuid, integer, uuid, uuid, uuid, uuid,
  text, timestamptz, timestamptz, timestamptz, timestamptz, integer, text,
  text, text, text, text, timestamptz, boolean
) IS
  'Service-role-only, caller-gated atomic closed-won onboarding handoff command. Makes no external calls.';
