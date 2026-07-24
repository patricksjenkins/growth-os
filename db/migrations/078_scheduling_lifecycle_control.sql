-- ============================================================================
-- Migration 078: No-touch scheduling lifecycle control (G06)
-- Date: 2026-07-24
--
-- Additive, default-off scheduling orchestration. It records lifecycle commands
-- and evidence atomically but cannot call a calendar or communications provider.
-- Existing appointment APIs and status values remain backward compatible.
--
-- ROLLBACK: db/rollbacks/078_scheduling_lifecycle_control_rollback.sql
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.scheduling_automation_controls (
  tenant_id                 uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  enabled                   boolean NOT NULL DEFAULT false,
  execution_mode            text NOT NULL DEFAULT 'disabled'
                              CHECK (execution_mode IN ('disabled', 'shadow', 'supervised')),
  kill_switch_engaged       boolean NOT NULL DEFAULT true,
  -- Migration 078 is evidence/control only. A later approved change must
  -- deliberately replace this constraint before any dispatcher can be enabled.
  provider_dispatch_enabled boolean NOT NULL DEFAULT false
                              CHECK (provider_dispatch_enabled = false),
  revision                  bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  activated_by              uuid,
  activation_evidence       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.appointment_lifecycle_controls (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  appointment_id           uuid NOT NULL REFERENCES public.appointment_workflows(id) ON DELETE CASCADE,
  lifecycle_state          text NOT NULL DEFAULT 'needed'
                             CHECK (lifecycle_state IN (
                               'needed', 'invitation_ready', 'invited', 'scheduled',
                               'reminder_due', 'reschedule_needed', 'prepared',
                               'completed', 'follow_up_due', 'follow_up_completed',
                               'exception', 'cancelled', 'no_show'
                             )),
  revision                 bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  reminder_count           integer NOT NULL DEFAULT 0 CHECK (reminder_count >= 0),
  next_reminder_at         timestamptz,
  exception_code           text,
  exception_at             timestamptz,
  last_action_at           timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, appointment_id),
  UNIQUE (id, tenant_id)
);

CREATE TABLE IF NOT EXISTS public.appointment_lifecycle_events (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  appointment_id           uuid NOT NULL REFERENCES public.appointment_workflows(id) ON DELETE CASCADE,
  lifecycle_control_id     uuid NOT NULL,
  action                   text NOT NULL,
  previous_state           text NOT NULL,
  next_state               text NOT NULL,
  expected_revision        bigint NOT NULL,
  resulting_revision       bigint NOT NULL,
  actor_type               text NOT NULL CHECK (actor_type IN ('human', 'system')),
  actor_id                 text,
  authority_tier           text NOT NULL CHECK (authority_tier IN ('system', 'owner')),
  evidence                 jsonb NOT NULL,
  evidence_digest          text NOT NULL CHECK (evidence_digest ~ '^[a-f0-9]{64}$'),
  request_fingerprint      text NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  semantic_fingerprint     text NOT NULL CHECK (semantic_fingerprint ~ '^[a-f0-9]{64}$'),
  idempotency_key          text NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (lifecycle_control_id, tenant_id)
    REFERENCES public.appointment_lifecycle_controls(id, tenant_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_appointment_lifecycle_due
  ON public.appointment_lifecycle_controls
    (tenant_id, lifecycle_state, next_reminder_at);
CREATE INDEX IF NOT EXISTS idx_appointment_lifecycle_events_history
  ON public.appointment_lifecycle_events
    (tenant_id, appointment_id, created_at, id);

CREATE OR REPLACE FUNCTION public.appointment_lifecycle_tenant_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.appointment_workflows appointment
     WHERE appointment.id = NEW.appointment_id
       AND appointment.tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'appointment_lifecycle_tenant_mismatch';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_appointment_lifecycle_controls_tenant_guard
  ON public.appointment_lifecycle_controls;
CREATE TRIGGER trg_appointment_lifecycle_controls_tenant_guard
  BEFORE INSERT OR UPDATE ON public.appointment_lifecycle_controls
  FOR EACH ROW EXECUTE FUNCTION public.appointment_lifecycle_tenant_guard();

DROP TRIGGER IF EXISTS trg_appointment_lifecycle_events_tenant_guard
  ON public.appointment_lifecycle_events;
CREATE TRIGGER trg_appointment_lifecycle_events_tenant_guard
  BEFORE INSERT ON public.appointment_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION public.appointment_lifecycle_tenant_guard();

DROP TRIGGER IF EXISTS trg_appointment_lifecycle_events_immutable
  ON public.appointment_lifecycle_events;
CREATE TRIGGER trg_appointment_lifecycle_events_immutable
  BEFORE UPDATE OR DELETE ON public.appointment_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION public.autonomous_os_immutable_row();

CREATE OR REPLACE FUNCTION public.scheduling_automation_control_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.enabled = true THEN
    IF NEW.execution_mode NOT IN ('shadow', 'supervised')
       OR NEW.kill_switch_engaged IS DISTINCT FROM false
       OR jsonb_typeof(NEW.activation_evidence) <> 'object'
       OR NEW.activation_evidence = '{}'::jsonb
       OR NEW.activated_by IS NULL
       OR NOT EXISTS (
         SELECT 1
           FROM public.tenant_users tenant_user
          WHERE tenant_user.tenant_id = NEW.tenant_id
            AND tenant_user.user_id = NEW.activated_by
            AND tenant_user.role IN (
              'owner', 'platform_owner', 'founder', 'admin',
              'client_owner', 'tenant_owner'
            )
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'scheduling_automation_activation_invalid';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    NEW.revision := OLD.revision + 1;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_scheduling_automation_control_guard
  ON public.scheduling_automation_controls;
CREATE TRIGGER trg_scheduling_automation_control_guard
  BEFORE INSERT OR UPDATE ON public.scheduling_automation_controls
  FOR EACH ROW EXECUTE FUNCTION public.scheduling_automation_control_guard();

ALTER TABLE public.scheduling_automation_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.appointment_lifecycle_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.appointment_lifecycle_events ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'scheduling_automation_controls',
    'appointment_lifecycle_controls',
    'appointment_lifecycle_events'
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
          'AND auth.jwt()->''app_metadata''->>''role'' IN (' ||
            '''owner'', ''platform_owner'', ''founder'', ''admin'', ' ||
            '''client_owner'', ''tenant_owner''' ||
          ')' ||
        ')',
        'tenant_iso_' || table_name,
        table_name
      );
    END IF;
  END LOOP;
END $$;

GRANT SELECT ON
  public.scheduling_automation_controls,
  public.appointment_lifecycle_controls,
  public.appointment_lifecycle_events
TO authenticated, service_role;
REVOKE INSERT, UPDATE, DELETE ON
  public.scheduling_automation_controls,
  public.appointment_lifecycle_controls,
  public.appointment_lifecycle_events
FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.appointment_lifecycle_command_rpc(
  p_tenant_id uuid,
  p_appointment_id uuid,
  p_action text,
  p_expected_revision bigint,
  p_idempotency_key text,
  p_request_fingerprint text,
  p_actor_type text,
  p_actor_id text,
  p_actor_authority_tier text,
  p_evidence jsonb,
  p_feature_gate_enabled boolean DEFAULT false,
  p_next_reminder_at timestamptz DEFAULT NULL,
  p_exception_code text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_claims text;
  v_calling_role text;
  v_automation public.scheduling_automation_controls%ROWTYPE;
  v_appointment public.appointment_workflows%ROWTYPE;
  v_control public.appointment_lifecycle_controls%ROWTYPE;
  v_existing_event public.appointment_lifecycle_events%ROWTYPE;
  v_event public.appointment_lifecycle_events%ROWTYPE;
  v_previous_state text;
  v_next_state text;
  v_evidence_observed_at timestamptz;
  v_evidence_digest text;
  v_semantic_fingerprint text;
  v_actor_uuid uuid;
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
      MESSAGE = 'appointment_lifecycle_requires_service_role';
  END IF;
  IF p_feature_gate_enabled IS DISTINCT FROM true THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'scheduling_lifecycle_writes_disabled';
  END IF;
  IF p_tenant_id IS NULL OR p_appointment_id IS NULL THEN
    RAISE EXCEPTION 'appointment_lifecycle_identity_required';
  END IF;
  IF p_action NOT IN (
    'mark_invitation_ready', 'record_invitation_delivery',
    'synchronize_booking', 'mark_reminder_due', 'record_reminder_delivery',
    'mark_reschedule_needed', 'mark_prepared', 'mark_completed',
    'mark_follow_up_due', 'mark_follow_up_complete', 'raise_exception'
  ) THEN
    RAISE EXCEPTION 'appointment_lifecycle_action_invalid';
  END IF;
  IF p_expected_revision IS NULL OR p_expected_revision < 0 THEN
    RAISE EXCEPTION 'appointment_lifecycle_revision_invalid';
  END IF;
  IF char_length(btrim(COALESCE(p_idempotency_key, ''))) NOT BETWEEN 8 AND 200 THEN
    RAISE EXCEPTION 'appointment_lifecycle_idempotency_invalid';
  END IF;
  IF p_request_fingerprint !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'appointment_lifecycle_fingerprint_invalid';
  END IF;
  IF jsonb_typeof(COALESCE(p_evidence, 'null'::jsonb)) <> 'object'
     OR p_evidence = '{}'::jsonb THEN
    RAISE EXCEPTION 'appointment_lifecycle_evidence_required';
  END IF;
  IF btrim(COALESCE(p_evidence->>'source_type', '')) NOT IN (
    'policy_evaluation', 'provider_receipt', 'document_receipt',
    'completion_receipt', 'system_clock', 'operator_decision'
  ) OR char_length(btrim(COALESCE(p_evidence->>'source_id', ''))) NOT BETWEEN 3 AND 240
     OR char_length(btrim(COALESCE(p_evidence->>'observed_at', ''))) = 0 THEN
    RAISE EXCEPTION 'appointment_lifecycle_evidence_invalid';
  END IF;
  BEGIN
    v_evidence_observed_at := (p_evidence->>'observed_at')::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'appointment_lifecycle_evidence_time_invalid';
  END;
  IF v_evidence_observed_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'appointment_lifecycle_evidence_from_future';
  END IF;
  IF p_actor_type NOT IN ('human', 'system')
     OR p_actor_authority_tier NOT IN ('system', 'owner') THEN
    RAISE EXCEPTION 'appointment_lifecycle_actor_invalid';
  END IF;
  IF p_actor_type = 'system' THEN
    IF p_actor_id IS NOT NULL OR p_actor_authority_tier <> 'system' THEN
      RAISE EXCEPTION 'appointment_lifecycle_system_actor_invalid';
    END IF;
  ELSE
    IF p_actor_authority_tier <> 'owner'
       OR p_actor_id IS NULL
       OR p_actor_id !~
         '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' THEN
      RAISE EXCEPTION 'appointment_lifecycle_human_actor_invalid';
    END IF;
    v_actor_uuid := p_actor_id::uuid;
    IF NOT EXISTS (
      SELECT 1
        FROM public.tenant_users tenant_user
       WHERE tenant_user.tenant_id = p_tenant_id
         AND tenant_user.user_id = v_actor_uuid
         AND tenant_user.role IN (
           'owner', 'platform_owner', 'founder', 'admin',
           'client_owner', 'tenant_owner'
         )
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'appointment_lifecycle_human_not_tenant_owner';
    END IF;
  END IF;

  SELECT automation.*
    INTO v_automation
    FROM public.scheduling_automation_controls automation
   WHERE automation.tenant_id = p_tenant_id
   FOR SHARE;
  IF NOT FOUND
     OR v_automation.enabled IS DISTINCT FROM true
     OR v_automation.execution_mode NOT IN ('shadow', 'supervised') THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'scheduling_lifecycle_tenant_not_enabled';
  END IF;
  IF v_automation.kill_switch_engaged IS DISTINCT FROM false THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'scheduling_lifecycle_kill_switch_engaged';
  END IF;
  IF v_automation.provider_dispatch_enabled IS DISTINCT FROM false THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'scheduling_lifecycle_dispatch_forbidden';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      p_tenant_id::text || ':appointment-lifecycle:' || p_appointment_id::text,
      0
    )
  );

  SELECT appointment.*
    INTO v_appointment
    FROM public.appointment_workflows appointment
   WHERE appointment.id = p_appointment_id
     AND appointment.tenant_id = p_tenant_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'appointment_lifecycle_not_found_for_tenant';
  END IF;
  IF v_evidence_observed_at < v_appointment.created_at THEN
    RAISE EXCEPTION 'appointment_lifecycle_evidence_predates_appointment';
  END IF;

  v_evidence_digest := encode(digest(p_evidence::text, 'sha256'), 'hex');
  v_semantic_fingerprint := encode(digest(
    concat_ws('|',
      p_tenant_id::text,
      p_appointment_id::text,
      p_action,
      p_expected_revision::text,
      COALESCE(p_next_reminder_at::text, ''),
      COALESCE(p_exception_code, ''),
      p_actor_type,
      COALESCE(p_actor_id, ''),
      p_actor_authority_tier,
      p_evidence::text
    ),
    'sha256'
  ), 'hex');
  SELECT event.*
    INTO v_existing_event
    FROM public.appointment_lifecycle_events event
   WHERE event.tenant_id = p_tenant_id
     AND event.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing_event.request_fingerprint IS DISTINCT FROM p_request_fingerprint
       OR v_existing_event.semantic_fingerprint IS DISTINCT FROM v_semantic_fingerprint
       OR v_existing_event.action IS DISTINCT FROM p_action
       OR v_existing_event.appointment_id IS DISTINCT FROM p_appointment_id THEN
      RAISE EXCEPTION USING
        ERRCODE = '23505',
        MESSAGE = 'appointment_lifecycle_idempotency_conflict';
    END IF;
    SELECT control.*
      INTO STRICT v_control
      FROM public.appointment_lifecycle_controls control
     WHERE control.id = v_existing_event.lifecycle_control_id
       AND control.tenant_id = p_tenant_id;
    RETURN jsonb_build_object(
      'outcome', 'replay',
      'control', to_jsonb(v_control),
      'event', to_jsonb(v_existing_event)
    );
  END IF;

  INSERT INTO public.appointment_lifecycle_controls (
    tenant_id, appointment_id, lifecycle_state
  ) VALUES (
    p_tenant_id,
    p_appointment_id,
    CASE v_appointment.status
      WHEN 'invitation_ready' THEN 'invitation_ready'
      WHEN 'invited' THEN 'invited'
      WHEN 'scheduled' THEN 'scheduled'
      WHEN 'prepared' THEN 'prepared'
      WHEN 'completed' THEN 'completed'
      WHEN 'reschedule_needed' THEN 'reschedule_needed'
      WHEN 'cancelled' THEN 'cancelled'
      WHEN 'no_show' THEN 'no_show'
      ELSE 'needed'
    END
  )
  ON CONFLICT (tenant_id, appointment_id) DO NOTHING;

  SELECT control.*
    INTO STRICT v_control
    FROM public.appointment_lifecycle_controls control
   WHERE control.tenant_id = p_tenant_id
     AND control.appointment_id = p_appointment_id
   FOR UPDATE;

  IF v_control.revision IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'appointment_lifecycle_revision_conflict';
  END IF;
  v_previous_state := v_control.lifecycle_state;
  v_next_state := v_previous_state;

  CASE p_action
    WHEN 'mark_invitation_ready' THEN
      IF v_appointment.status NOT IN ('needed', 'reschedule_needed', 'failed')
         OR v_previous_state NOT IN ('needed', 'reschedule_needed') THEN
        RAISE EXCEPTION 'appointment_lifecycle_transition_invalid';
      END IF;
      v_next_state := 'invitation_ready';
      UPDATE public.appointment_workflows
         SET status = 'invitation_ready', exception_reason = NULL, updated_at = now()
       WHERE id = p_appointment_id AND tenant_id = p_tenant_id;
    WHEN 'record_invitation_delivery' THEN
      IF v_appointment.status <> 'invitation_ready'
         OR v_previous_state <> 'invitation_ready'
         OR p_evidence->>'source_type' <> 'provider_receipt' THEN
        RAISE EXCEPTION 'appointment_lifecycle_transition_invalid';
      END IF;
      v_next_state := 'invited';
      UPDATE public.appointment_workflows
         SET status = 'invited', updated_at = now()
       WHERE id = p_appointment_id AND tenant_id = p_tenant_id;
    WHEN 'synchronize_booking' THEN
      IF v_appointment.status <> 'scheduled'
         OR v_previous_state NOT IN ('invited', 'invitation_ready', 'reschedule_needed', 'scheduled')
         OR p_evidence->>'source_type' <> 'provider_receipt' THEN
        RAISE EXCEPTION 'appointment_lifecycle_transition_invalid';
      END IF;
      v_next_state := 'scheduled';
    WHEN 'mark_reminder_due' THEN
      IF v_appointment.status NOT IN ('invited', 'scheduled', 'prepared')
         OR v_previous_state NOT IN ('invited', 'scheduled', 'prepared')
         OR p_evidence->>'source_type' <> 'system_clock'
         OR p_next_reminder_at IS NOT NULL
         OR v_control.next_reminder_at IS NULL
         OR v_control.next_reminder_at > v_evidence_observed_at
         OR NULLIF(p_evidence->>'due_at', '')::timestamptz
              IS DISTINCT FROM v_control.next_reminder_at THEN
        RAISE EXCEPTION 'appointment_lifecycle_transition_invalid';
      END IF;
      v_next_state := 'reminder_due';
    WHEN 'record_reminder_delivery' THEN
      IF v_previous_state <> 'reminder_due'
         OR v_appointment.status NOT IN ('invited', 'scheduled', 'prepared')
         OR p_evidence->>'source_type' <> 'provider_receipt' THEN
        RAISE EXCEPTION 'appointment_lifecycle_transition_invalid';
      END IF;
      v_next_state := CASE v_appointment.status
        WHEN 'prepared' THEN 'prepared'
        WHEN 'scheduled' THEN 'scheduled'
        ELSE 'invited'
      END;
    WHEN 'mark_reschedule_needed' THEN
      IF v_appointment.status NOT IN (
        'invited', 'scheduled', 'prepared', 'no_show', 'cancelled'
      )
         OR v_previous_state IN ('completed', 'follow_up_due', 'follow_up_completed') THEN
        RAISE EXCEPTION 'appointment_lifecycle_transition_invalid';
      END IF;
      v_next_state := 'reschedule_needed';
      IF v_appointment.status <> 'cancelled' THEN
        UPDATE public.appointment_workflows
           SET status = 'reschedule_needed',
               exception_reason = 'reschedule_required',
               updated_at = now()
         WHERE id = p_appointment_id AND tenant_id = p_tenant_id;
      END IF;
    WHEN 'mark_prepared' THEN
      IF v_appointment.status <> 'scheduled'
         OR v_previous_state NOT IN ('scheduled', 'reminder_due')
         OR p_evidence->>'source_type' <> 'document_receipt'
         OR v_appointment.preparation_document_id IS NULL THEN
        RAISE EXCEPTION 'appointment_lifecycle_transition_invalid';
      END IF;
      v_next_state := 'prepared';
      UPDATE public.appointment_workflows
         SET status = 'prepared', updated_at = now()
       WHERE id = p_appointment_id AND tenant_id = p_tenant_id;
    WHEN 'mark_completed' THEN
      IF v_appointment.status <> 'prepared'
         OR v_previous_state NOT IN ('prepared', 'reminder_due')
         OR p_evidence->>'source_type' <> 'completion_receipt'
         OR v_appointment.outcome_code IS NULL THEN
        RAISE EXCEPTION 'appointment_lifecycle_transition_invalid';
      END IF;
      v_next_state := 'completed';
      UPDATE public.appointment_workflows
         SET status = 'completed', updated_at = now()
       WHERE id = p_appointment_id AND tenant_id = p_tenant_id;
    WHEN 'mark_follow_up_due' THEN
      IF v_appointment.status <> 'completed'
         OR v_previous_state <> 'completed'
         OR p_evidence->>'source_type' <> 'system_clock'
         OR v_appointment.follow_up_due_at IS NULL
         OR v_appointment.follow_up_due_at > v_evidence_observed_at THEN
        RAISE EXCEPTION 'appointment_lifecycle_transition_invalid';
      END IF;
      v_next_state := 'follow_up_due';
    WHEN 'mark_follow_up_complete' THEN
      IF v_appointment.status <> 'completed'
         OR v_previous_state <> 'follow_up_due'
         OR p_evidence->>'source_type' <> 'provider_receipt' THEN
        RAISE EXCEPTION 'appointment_lifecycle_transition_invalid';
      END IF;
      v_next_state := 'follow_up_completed';
    WHEN 'raise_exception' THEN
      IF v_previous_state IN ('completed', 'follow_up_completed', 'cancelled')
         OR char_length(btrim(COALESCE(p_exception_code, ''))) NOT BETWEEN 3 AND 80 THEN
        RAISE EXCEPTION 'appointment_lifecycle_transition_invalid';
      END IF;
      v_next_state := 'exception';
  END CASE;

  UPDATE public.appointment_lifecycle_controls
     SET lifecycle_state = v_next_state,
         revision = revision + 1,
         reminder_count = CASE
           WHEN p_action = 'record_reminder_delivery' THEN reminder_count + 1
           ELSE reminder_count
         END,
         next_reminder_at = CASE
           WHEN p_action = 'synchronize_booking' THEN p_next_reminder_at
           WHEN p_action = 'record_reminder_delivery' THEN p_next_reminder_at
           WHEN p_action = 'mark_reminder_due' THEN NULL
           ELSE next_reminder_at
         END,
         exception_code = CASE
           WHEN p_action = 'raise_exception' THEN btrim(p_exception_code)
           ELSE exception_code
         END,
         exception_at = CASE
           WHEN p_action = 'raise_exception' THEN now()
           ELSE exception_at
         END,
         last_action_at = now(),
         updated_at = now()
   WHERE id = v_control.id AND tenant_id = p_tenant_id
  RETURNING * INTO v_control;

  INSERT INTO public.appointment_lifecycle_events (
    tenant_id, appointment_id, lifecycle_control_id, action,
    previous_state, next_state, expected_revision, resulting_revision,
    actor_type, actor_id, authority_tier, evidence, evidence_digest,
    request_fingerprint, semantic_fingerprint, idempotency_key
  ) VALUES (
    p_tenant_id, p_appointment_id, v_control.id, p_action,
    v_previous_state, v_next_state, p_expected_revision, v_control.revision,
    p_actor_type, p_actor_id, p_actor_authority_tier, p_evidence,
    v_evidence_digest, p_request_fingerprint, v_semantic_fingerprint,
    btrim(p_idempotency_key)
  )
  RETURNING * INTO v_event;

  RETURN jsonb_build_object(
    'outcome', 'applied',
    'control', to_jsonb(v_control),
    'event', to_jsonb(v_event)
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.appointment_lifecycle_command_rpc(
  uuid, uuid, text, bigint, text, text, text, text, text, jsonb,
  boolean, timestamptz, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.appointment_lifecycle_command_rpc(
  uuid, uuid, text, bigint, text, text, text, text, text, jsonb,
  boolean, timestamptz, text
) TO service_role;

REVOKE EXECUTE ON FUNCTION public.appointment_lifecycle_tenant_guard()
FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.scheduling_automation_control_guard()
FROM PUBLIC, anon, authenticated, service_role;

-- The fail-safe direction is always available to the service boundary. This
-- function cannot enable a tenant, clear a kill switch, or dispatch anything.
CREATE OR REPLACE FUNCTION public.scheduling_lifecycle_kill_switch_rpc(
  p_tenant_id uuid,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_claims text;
  v_calling_role text;
  v_control public.scheduling_automation_controls%ROWTYPE;
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
      MESSAGE = 'scheduling_kill_switch_requires_service_role';
  END IF;
  IF p_tenant_id IS NULL
     OR btrim(COALESCE(p_reason, '')) !~ '^[a-z0-9][a-z0-9_:-]{2,79}$' THEN
    RAISE EXCEPTION 'scheduling_kill_switch_reason_required';
  END IF;

  UPDATE public.scheduling_automation_controls
     SET enabled = false,
         execution_mode = 'disabled',
         kill_switch_engaged = true,
         activation_evidence = activation_evidence || jsonb_build_object(
           'kill_switch_reason', btrim(p_reason),
           'kill_switch_engaged_at', now()
         )
   WHERE tenant_id = p_tenant_id
  RETURNING * INTO v_control;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'scheduling_kill_switch_tenant_control_not_found';
  END IF;
  RETURN jsonb_build_object(
    'outcome', 'kill_switch_engaged',
    'tenant_id', v_control.tenant_id,
    'revision', v_control.revision
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.scheduling_lifecycle_kill_switch_rpc(
  uuid, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.scheduling_lifecycle_kill_switch_rpc(
  uuid, text
) TO service_role;
