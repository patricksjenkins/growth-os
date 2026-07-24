-- ============================================================================
-- Migration 083: Evidence-backed client-health interventions (G12)
-- Date: 2026-07-24
--
-- Additive, backward-compatible, and inert by default. Existing heuristic
-- client_health_scores remain untouched, but cannot authorize or prove an
-- outcome in this control plane. This migration performs no provider calls,
-- sends no customer communications, and changes no deployed health workflow.
--
-- ROLLBACK: db/rollbacks/083_client_health_interventions_rollback.sql
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.client_health_automation_controls (
  tenant_id                         uuid PRIMARY KEY
                                    REFERENCES public.tenants(id) ON DELETE CASCADE,
  enabled                           boolean NOT NULL DEFAULT false,
  execution_mode                    text NOT NULL DEFAULT 'disabled'
                                    CHECK (execution_mode IN (
                                      'disabled', 'shadow', 'supervised'
                                    )),
  kill_switch_engaged               boolean NOT NULL DEFAULT true,
  customer_communications_enabled   boolean NOT NULL DEFAULT false
                                    CHECK (customer_communications_enabled = false),
  provider_actions_enabled          boolean NOT NULL DEFAULT false
                                    CHECK (provider_actions_enabled = false),
  revision                          bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  activated_by                      uuid,
  activation_evidence               jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                        timestamptz NOT NULL DEFAULT now(),
  updated_at                        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.client_health_signal_snapshots (
  id                                uuid PRIMARY KEY,
  tenant_id                         uuid NOT NULL
                                    REFERENCES public.tenants(id) ON DELETE RESTRICT,
  customer_id                       uuid NOT NULL
                                    REFERENCES public.customers(id) ON DELETE RESTRICT,
  signal_state                      text NOT NULL DEFAULT 'unknown'
                                    CHECK (signal_state IN (
                                      'unknown', 'unproven', 'at_risk', 'stable'
                                    )),
  provenance_type                   text NOT NULL
                                    CHECK (provenance_type IN ('heuristic', 'observed')),
  dimensions                        jsonb NOT NULL CHECK (
                                      jsonb_typeof(dimensions) = 'object'
                                      AND dimensions <> '{}'::jsonb
                                    ),
  outcome_evidence_eligible         boolean NOT NULL DEFAULT false,
  evidence                          jsonb NOT NULL CHECK (
                                      jsonb_typeof(evidence) = 'object'
                                      AND evidence <> '{}'::jsonb
                                    ),
  evidence_digest                   text NOT NULL
                                    CHECK (evidence_digest ~ '^[a-f0-9]{64}$'),
  evidence_observed_at              timestamptz NOT NULL,
  actor_type                        text NOT NULL
                                    CHECK (actor_type IN ('human', 'service', 'system')),
  actor_id                          text,
  authority_tier                    text NOT NULL
                                    CHECK (authority_tier IN (
                                      'system', 'client_success', 'owner'
                                    )),
  idempotency_key                   text NOT NULL
                                    CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  request_fingerprint               text NOT NULL
                                    CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  semantic_fingerprint              text NOT NULL
                                    CHECK (semantic_fingerprint ~ '^[a-f0-9]{64}$'),
  created_at                        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (id, tenant_id, customer_id),
  UNIQUE (tenant_id, idempotency_key),
  CHECK (
    (provenance_type = 'heuristic' AND outcome_evidence_eligible = false)
    OR provenance_type = 'observed'
  ),
  CHECK (NOT (provenance_type = 'heuristic' AND signal_state = 'stable')),
  CHECK (
    (actor_type = 'system' AND actor_id IS NULL AND authority_tier = 'system')
    OR
    (
      actor_type = 'service'
      AND NULLIF(btrim(actor_id), '') IS NOT NULL
      AND authority_tier IN ('system', 'client_success')
    )
    OR
    (
      actor_type = 'human'
      AND actor_id ~
        '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
      AND authority_tier IN ('client_success', 'owner')
    )
  ),
  CHECK (evidence_observed_at <= created_at + interval '5 minutes')
);

CREATE TABLE IF NOT EXISTS public.client_health_interventions (
  id                                uuid PRIMARY KEY,
  tenant_id                         uuid NOT NULL
                                    REFERENCES public.tenants(id) ON DELETE RESTRICT,
  customer_id                       uuid NOT NULL
                                    REFERENCES public.customers(id) ON DELETE RESTRICT,
  source_signal_snapshot_id         uuid NOT NULL,
  lifecycle_state                   text NOT NULL DEFAULT 'assigned'
                                    CHECK (lifecycle_state IN (
                                      'assigned', 'accepted', 'escalated',
                                      'action_completed', 'outcome_recorded'
                                    )),
  revision                          bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  owner_id                          uuid NOT NULL,
  assignee_id                       uuid NOT NULL,
  action_plan                       jsonb NOT NULL CHECK (
                                      jsonb_typeof(action_plan) = 'object'
                                      AND NULLIF(btrim(action_plan->>'objective'), '') IS NOT NULL
                                      AND NULLIF(btrim(action_plan->>'action_type'), '') IS NOT NULL
                                      AND NULLIF(btrim(action_plan->>'success_metric'), '') IS NOT NULL
                                    ),
  assigned_at                       timestamptz NOT NULL,
  accepted_at                       timestamptz,
  sla_due_at                        timestamptz NOT NULL,
  escalated_at                      timestamptz,
  escalation_code                   text CHECK (
                                      escalation_code IS NULL
                                      OR escalation_code ~ '^[a-z][a-z0-9_]{2,79}$'
                                    ),
  action_completed_at               timestamptz,
  completion_evidence_digest        text CHECK (
                                      completion_evidence_digest IS NULL
                                      OR completion_evidence_digest ~ '^[a-f0-9]{64}$'
                                    ),
  outcome_state                     text NOT NULL DEFAULT 'unknown'
                                    CHECK (outcome_state IN (
                                      'unknown', 'unproven', 'improved',
                                      'unchanged', 'worsened'
                                    )),
  outcome_evidence_digest           text CHECK (
                                      outcome_evidence_digest IS NULL
                                      OR outcome_evidence_digest ~ '^[a-f0-9]{64}$'
                                    ),
  outcome_observed_at               timestamptz,
  outcome_verified                  boolean GENERATED ALWAYS AS (
                                      outcome_state IN (
                                        'improved', 'unchanged', 'worsened'
                                      )
                                      AND outcome_evidence_digest IS NOT NULL
                                      AND outcome_observed_at IS NOT NULL
                                    ) STORED,
  outcome_healthy                   boolean GENERATED ALWAYS AS (
                                      outcome_state = 'improved'
                                      AND outcome_evidence_digest IS NOT NULL
                                      AND outcome_observed_at IS NOT NULL
                                    ) STORED,
  last_action_at                    timestamptz NOT NULL,
  created_at                        timestamptz NOT NULL DEFAULT now(),
  updated_at                        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (id, tenant_id, customer_id),
  FOREIGN KEY (source_signal_snapshot_id, tenant_id, customer_id)
    REFERENCES public.client_health_signal_snapshots(id, tenant_id, customer_id)
    ON DELETE RESTRICT,
  CHECK (sla_due_at > assigned_at),
  CHECK (
    (lifecycle_state = 'assigned'
      AND accepted_at IS NULL
      AND escalated_at IS NULL
      AND action_completed_at IS NULL
      AND completion_evidence_digest IS NULL
      AND outcome_state IN ('unknown', 'unproven')
      AND outcome_evidence_digest IS NULL
      AND outcome_observed_at IS NULL)
    OR
    (lifecycle_state = 'accepted'
      AND accepted_at IS NOT NULL
      AND escalated_at IS NULL
      AND action_completed_at IS NULL
      AND completion_evidence_digest IS NULL
      AND outcome_state IN ('unknown', 'unproven')
      AND outcome_evidence_digest IS NULL
      AND outcome_observed_at IS NULL)
    OR
    (lifecycle_state = 'escalated'
      AND escalated_at IS NOT NULL
      AND escalation_code IS NOT NULL
      AND action_completed_at IS NULL
      AND completion_evidence_digest IS NULL
      AND outcome_state IN ('unknown', 'unproven')
      AND outcome_evidence_digest IS NULL
      AND outcome_observed_at IS NULL)
    OR
    (lifecycle_state = 'action_completed'
      AND accepted_at IS NOT NULL
      AND action_completed_at IS NOT NULL
      AND completion_evidence_digest IS NOT NULL
      AND outcome_state = 'unproven'
      AND outcome_evidence_digest IS NULL
      AND outcome_observed_at IS NULL)
    OR
    (lifecycle_state = 'outcome_recorded'
      AND accepted_at IS NOT NULL
      AND action_completed_at IS NOT NULL
      AND completion_evidence_digest IS NOT NULL
      AND outcome_state IN ('improved', 'unchanged', 'worsened')
      AND outcome_evidence_digest IS NOT NULL
      AND outcome_observed_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS public.client_health_intervention_events (
  id                                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                         uuid NOT NULL,
  customer_id                       uuid NOT NULL,
  intervention_id                   uuid NOT NULL,
  action                            text NOT NULL CHECK (action IN (
                                      'open_intervention', 'accept_assignment',
                                      'escalate', 'complete_action', 'record_outcome'
                                    )),
  previous_state                    text NOT NULL,
  next_state                        text NOT NULL,
  previous_outcome_state            text NOT NULL,
  next_outcome_state                text NOT NULL,
  expected_revision                 bigint NOT NULL CHECK (expected_revision >= 0),
  resulting_revision                bigint NOT NULL CHECK (resulting_revision > 0),
  actor_type                        text NOT NULL
                                    CHECK (actor_type IN ('human', 'service', 'system')),
  actor_id                          text,
  authority_tier                    text NOT NULL
                                    CHECK (authority_tier IN (
                                      'system', 'client_success', 'owner'
                                    )),
  evidence                          jsonb NOT NULL CHECK (
                                      jsonb_typeof(evidence) = 'object'
                                      AND evidence <> '{}'::jsonb
                                    ),
  evidence_digest                   text NOT NULL
                                    CHECK (evidence_digest ~ '^[a-f0-9]{64}$'),
  target_signal_snapshot_id         uuid,
  request_fingerprint               text NOT NULL
                                    CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  semantic_fingerprint              text NOT NULL
                                    CHECK (semantic_fingerprint ~ '^[a-f0-9]{64}$'),
  idempotency_key                   text NOT NULL
                                    CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  created_at                        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (intervention_id, tenant_id, customer_id)
    REFERENCES public.client_health_interventions(id, tenant_id, customer_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (target_signal_snapshot_id, tenant_id, customer_id)
    REFERENCES public.client_health_signal_snapshots(id, tenant_id, customer_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_client_health_signals_customer
  ON public.client_health_signal_snapshots
    (tenant_id, customer_id, evidence_observed_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_client_health_interventions_customer
  ON public.client_health_interventions
    (tenant_id, customer_id, lifecycle_state, sla_due_at);
CREATE INDEX IF NOT EXISTS idx_client_health_interventions_due
  ON public.client_health_interventions
    (tenant_id, lifecycle_state, sla_due_at)
  WHERE lifecycle_state IN ('assigned', 'accepted', 'escalated');
CREATE INDEX IF NOT EXISTS idx_client_health_intervention_events_history
  ON public.client_health_intervention_events
    (tenant_id, customer_id, intervention_id, created_at, id);

CREATE OR REPLACE FUNCTION public.client_health_immutable_evidence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'client_health_evidence_is_immutable';
END;
$$;

DROP TRIGGER IF EXISTS trg_client_health_signal_snapshots_immutable
  ON public.client_health_signal_snapshots;
CREATE TRIGGER trg_client_health_signal_snapshots_immutable
  BEFORE UPDATE OR DELETE ON public.client_health_signal_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.client_health_immutable_evidence();

DROP TRIGGER IF EXISTS trg_client_health_intervention_events_immutable
  ON public.client_health_intervention_events;
CREATE TRIGGER trg_client_health_intervention_events_immutable
  BEFORE UPDATE OR DELETE ON public.client_health_intervention_events
  FOR EACH ROW EXECUTE FUNCTION public.client_health_immutable_evidence();

CREATE OR REPLACE FUNCTION public.client_health_identity_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.customers customer
     WHERE customer.id = NEW.customer_id
       AND customer.tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'client_health_customer_not_found_for_tenant';
  END IF;
  IF TG_TABLE_NAME = 'client_health_interventions' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.tenant_users tenant_user
       WHERE tenant_user.tenant_id = NEW.tenant_id
         AND tenant_user.user_id = NEW.owner_id
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'client_health_owner_tenant_mismatch';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.tenant_users tenant_user
       WHERE tenant_user.tenant_id = NEW.tenant_id
         AND tenant_user.user_id = NEW.assignee_id
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'client_health_assignee_tenant_mismatch';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_client_health_signal_identity_guard
  ON public.client_health_signal_snapshots;
CREATE TRIGGER trg_client_health_signal_identity_guard
  BEFORE INSERT ON public.client_health_signal_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.client_health_identity_guard();

DROP TRIGGER IF EXISTS trg_client_health_intervention_identity_guard
  ON public.client_health_interventions;
CREATE TRIGGER trg_client_health_intervention_identity_guard
  BEFORE INSERT OR UPDATE ON public.client_health_interventions
  FOR EACH ROW EXECUTE FUNCTION public.client_health_identity_guard();

CREATE OR REPLACE FUNCTION public.client_health_control_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.customer_communications_enabled IS DISTINCT FROM false
     OR NEW.provider_actions_enabled IS DISTINCT FROM false THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'client_health_external_action_forbidden';
  END IF;
  IF NEW.enabled THEN
    IF NEW.execution_mode NOT IN ('shadow', 'supervised')
       OR NEW.kill_switch_engaged
       OR NEW.activated_by IS NULL
       OR jsonb_typeof(NEW.activation_evidence) <> 'object'
       OR NEW.activation_evidence = '{}'::jsonb THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'client_health_activation_invalid';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.tenant_users tenant_user
       WHERE tenant_user.tenant_id = NEW.tenant_id
         AND tenant_user.user_id = NEW.activated_by
         AND tenant_user.role IN (
           'owner', 'platform_owner', 'founder', 'admin',
           'client_owner', 'tenant_owner'
         )
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'client_health_activation_actor_not_tenant_admin';
    END IF;
  ELSIF NEW.execution_mode <> 'disabled' THEN
    RAISE EXCEPTION 'client_health_disabled_mode_invalid';
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.kill_switch_engaged = true
     AND NEW.kill_switch_engaged = false THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'client_health_kill_switch_is_one_way';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_client_health_control_guard
  ON public.client_health_automation_controls;
CREATE TRIGGER trg_client_health_control_guard
  BEFORE INSERT OR UPDATE ON public.client_health_automation_controls
  FOR EACH ROW EXECUTE FUNCTION public.client_health_control_guard();

ALTER TABLE public.client_health_automation_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_health_signal_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_health_interventions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_health_intervention_events ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'client_health_automation_controls',
    'client_health_signal_snapshots',
    'client_health_interventions',
    'client_health_intervention_events'
  ] LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON public.%I',
      'tenant_iso_' || table_name,
      table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated ' ||
      'USING (' ||
        'tenant_id = NULLIF(auth.jwt()->''app_metadata''->>''tenant_id'', '''')::uuid ' ||
        'AND auth.jwt()->''app_metadata''->>''role'' IN (' ||
          '''owner'', ''platform_owner'', ''founder'', ''admin'', ' ||
          '''client_owner'', ''tenant_owner'', ''client_success''' ||
        ')' ||
      ')',
      'tenant_iso_' || table_name,
      table_name
    );
  END LOOP;
END $$;

GRANT SELECT ON
  public.client_health_automation_controls,
  public.client_health_signal_snapshots,
  public.client_health_interventions,
  public.client_health_intervention_events
TO authenticated, service_role;
REVOKE INSERT, UPDATE, DELETE ON
  public.client_health_automation_controls,
  public.client_health_signal_snapshots,
  public.client_health_interventions,
  public.client_health_intervention_events
FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.client_health_signal_snapshot_rpc(
  p_tenant_id uuid,
  p_customer_id uuid,
  p_snapshot_id uuid,
  p_signal_state text,
  p_provenance_type text,
  p_dimensions jsonb,
  p_evidence jsonb,
  p_idempotency_key text,
  p_request_fingerprint text,
  p_actor_type text,
  p_actor_id text,
  p_authority_tier text,
  p_expected_control_revision bigint,
  p_feature_gate_enabled boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_claims text;
  v_calling_role text;
  v_control public.client_health_automation_controls%ROWTYPE;
  v_existing public.client_health_signal_snapshots%ROWTYPE;
  v_snapshot public.client_health_signal_snapshots%ROWTYPE;
  v_actor_uuid uuid;
  v_observed_at timestamptz;
  v_evidence_digest text;
  v_semantic_fingerprint text;
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
      MESSAGE = 'client_health_requires_service_role';
  END IF;
  IF p_feature_gate_enabled IS DISTINCT FROM true THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'client_health_writes_disabled';
  END IF;
  IF p_tenant_id IS NULL OR p_customer_id IS NULL OR p_snapshot_id IS NULL THEN
    RAISE EXCEPTION 'client_health_identity_required';
  END IF;
  IF p_expected_control_revision IS NULL OR p_expected_control_revision < 0 THEN
    RAISE EXCEPTION 'client_health_control_revision_invalid';
  END IF;
  IF p_signal_state NOT IN ('unknown', 'unproven', 'at_risk', 'stable')
     OR p_provenance_type NOT IN ('heuristic', 'observed')
     OR (p_provenance_type = 'heuristic' AND p_signal_state = 'stable') THEN
    RAISE EXCEPTION 'client_health_signal_contract_invalid';
  END IF;
  IF jsonb_typeof(COALESCE(p_dimensions, 'null'::jsonb)) <> 'object'
     OR p_dimensions = '{}'::jsonb THEN
    RAISE EXCEPTION 'client_health_dimensions_required';
  END IF;
  IF jsonb_typeof(COALESCE(p_evidence, 'null'::jsonb)) <> 'object'
     OR p_evidence = '{}'::jsonb
     OR char_length(btrim(COALESCE(p_evidence->>'source_type', ''))) NOT BETWEEN 3 AND 60
     OR char_length(btrim(COALESCE(p_evidence->>'source_id', ''))) NOT BETWEEN 3 AND 240
     OR NULLIF(btrim(p_evidence->>'observed_at'), '') IS NULL THEN
    RAISE EXCEPTION 'client_health_evidence_invalid';
  END IF;
  BEGIN
    v_observed_at := (p_evidence->>'observed_at')::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'client_health_evidence_time_invalid';
  END;
  IF v_observed_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'client_health_evidence_from_future';
  END IF;
  IF char_length(btrim(COALESCE(p_idempotency_key, ''))) NOT BETWEEN 8 AND 200
     OR p_request_fingerprint !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'client_health_idempotency_invalid';
  END IF;

  IF p_actor_type NOT IN ('human', 'service', 'system')
     OR p_authority_tier NOT IN ('system', 'client_success', 'owner') THEN
    RAISE EXCEPTION 'client_health_actor_invalid';
  END IF;
  IF p_actor_type = 'system' THEN
    IF p_actor_id IS NOT NULL OR p_authority_tier <> 'system' THEN
      RAISE EXCEPTION 'client_health_system_actor_invalid';
    END IF;
  ELSIF p_actor_type = 'service' THEN
    IF char_length(btrim(COALESCE(p_actor_id, ''))) NOT BETWEEN 2 AND 160
       OR p_authority_tier NOT IN ('system', 'client_success') THEN
      RAISE EXCEPTION 'client_health_service_actor_invalid';
    END IF;
  ELSE
    IF p_actor_id !~
      '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
      OR p_authority_tier NOT IN ('client_success', 'owner') THEN
      RAISE EXCEPTION 'client_health_human_actor_invalid';
    END IF;
    v_actor_uuid := p_actor_id::uuid;
    IF NOT EXISTS (
      SELECT 1 FROM public.tenant_users tenant_user
       WHERE tenant_user.tenant_id = p_tenant_id
         AND tenant_user.user_id = v_actor_uuid
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'client_health_human_not_tenant_member';
    END IF;
  END IF;

  SELECT control.* INTO v_control
    FROM public.client_health_automation_controls control
   WHERE control.tenant_id = p_tenant_id
   FOR SHARE;
  IF NOT FOUND
     OR v_control.enabled IS DISTINCT FROM true
     OR v_control.execution_mode NOT IN ('shadow', 'supervised') THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'client_health_tenant_not_enabled';
  END IF;
  IF v_control.kill_switch_engaged IS DISTINCT FROM false THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'client_health_kill_switch_engaged';
  END IF;
  IF v_control.revision IS DISTINCT FROM p_expected_control_revision THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'client_health_control_revision_conflict';
  END IF;
  IF v_control.customer_communications_enabled IS DISTINCT FROM false
     OR v_control.provider_actions_enabled IS DISTINCT FROM false THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'client_health_external_action_forbidden';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.customers customer
     WHERE customer.id = p_customer_id
       AND customer.tenant_id = p_tenant_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'client_health_customer_not_found_for_tenant';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_tenant_id::text || ':client-health:' || p_customer_id::text, 0)
  );
  v_evidence_digest := encode(digest(p_evidence::text, 'sha256'), 'hex');
  v_semantic_fingerprint := encode(digest(
    concat_ws('|',
      p_tenant_id::text, p_customer_id::text, p_snapshot_id::text,
      p_signal_state, p_provenance_type, p_dimensions::text, p_evidence::text,
      p_actor_type, COALESCE(p_actor_id, ''), p_authority_tier,
      p_expected_control_revision::text
    ),
    'sha256'
  ), 'hex');

  SELECT snapshot.* INTO v_existing
    FROM public.client_health_signal_snapshots snapshot
   WHERE snapshot.tenant_id = p_tenant_id
     AND snapshot.idempotency_key = btrim(p_idempotency_key);
  IF FOUND THEN
    IF v_existing.customer_id IS DISTINCT FROM p_customer_id
       OR v_existing.id IS DISTINCT FROM p_snapshot_id
       OR v_existing.request_fingerprint IS DISTINCT FROM p_request_fingerprint
       OR v_existing.semantic_fingerprint IS DISTINCT FROM v_semantic_fingerprint THEN
      RAISE EXCEPTION USING
        ERRCODE = '23505',
        MESSAGE = 'client_health_idempotency_conflict';
    END IF;
    RETURN jsonb_build_object('outcome', 'replay', 'snapshot', to_jsonb(v_existing));
  END IF;

  INSERT INTO public.client_health_signal_snapshots (
    id, tenant_id, customer_id, signal_state, provenance_type, dimensions,
    outcome_evidence_eligible, evidence, evidence_digest, evidence_observed_at,
    actor_type, actor_id, authority_tier, idempotency_key,
    request_fingerprint, semantic_fingerprint
  ) VALUES (
    p_snapshot_id, p_tenant_id, p_customer_id, p_signal_state,
    p_provenance_type, p_dimensions, false, p_evidence, v_evidence_digest,
    v_observed_at, p_actor_type, p_actor_id, p_authority_tier,
    btrim(p_idempotency_key), p_request_fingerprint, v_semantic_fingerprint
  )
  RETURNING * INTO v_snapshot;

  RETURN jsonb_build_object('outcome', 'applied', 'snapshot', to_jsonb(v_snapshot));
END;
$$;

CREATE OR REPLACE FUNCTION public.client_health_intervention_command_rpc(
  p_tenant_id uuid,
  p_customer_id uuid,
  p_intervention_id uuid,
  p_action text,
  p_expected_revision bigint,
  p_idempotency_key text,
  p_request_fingerprint text,
  p_actor_type text,
  p_actor_id text,
  p_authority_tier text,
  p_evidence jsonb,
  p_expected_control_revision bigint,
  p_feature_gate_enabled boolean DEFAULT false,
  p_signal_snapshot_id uuid DEFAULT NULL,
  p_owner_id uuid DEFAULT NULL,
  p_assignee_id uuid DEFAULT NULL,
  p_sla_due_at timestamptz DEFAULT NULL,
  p_action_plan jsonb DEFAULT NULL,
  p_escalation_code text DEFAULT NULL,
  p_outcome_state text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_claims text;
  v_calling_role text;
  v_control public.client_health_automation_controls%ROWTYPE;
  v_intervention public.client_health_interventions%ROWTYPE;
  v_existing_event public.client_health_intervention_events%ROWTYPE;
  v_event public.client_health_intervention_events%ROWTYPE;
  v_actor_uuid uuid;
  v_previous_state text;
  v_next_state text;
  v_previous_outcome_state text;
  v_next_outcome_state text;
  v_accepted_at timestamptz;
  v_escalated_at timestamptz;
  v_escalation_code text;
  v_action_completed_at timestamptz;
  v_completion_evidence_digest text;
  v_outcome_evidence_digest text;
  v_outcome_observed_at timestamptz;
  v_observed_at timestamptz;
  v_evidence_digest text;
  v_semantic_fingerprint text;
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
      MESSAGE = 'client_health_requires_service_role';
  END IF;
  IF p_feature_gate_enabled IS DISTINCT FROM true THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'client_health_writes_disabled';
  END IF;
  IF p_tenant_id IS NULL OR p_customer_id IS NULL OR p_intervention_id IS NULL THEN
    RAISE EXCEPTION 'client_health_identity_required';
  END IF;
  IF p_action NOT IN (
    'open_intervention', 'accept_assignment', 'escalate',
    'complete_action', 'record_outcome'
  ) THEN
    RAISE EXCEPTION 'client_health_action_invalid';
  END IF;
  IF p_expected_revision IS NULL OR p_expected_revision < 0
     OR p_expected_control_revision IS NULL OR p_expected_control_revision < 0 THEN
    RAISE EXCEPTION 'client_health_revision_invalid';
  END IF;
  IF char_length(btrim(COALESCE(p_idempotency_key, ''))) NOT BETWEEN 8 AND 200
     OR p_request_fingerprint !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'client_health_idempotency_invalid';
  END IF;
  IF jsonb_typeof(COALESCE(p_evidence, 'null'::jsonb)) <> 'object'
     OR p_evidence = '{}'::jsonb
     OR char_length(btrim(COALESCE(p_evidence->>'source_type', ''))) NOT BETWEEN 3 AND 60
     OR char_length(btrim(COALESCE(p_evidence->>'source_id', ''))) NOT BETWEEN 3 AND 240
     OR NULLIF(btrim(p_evidence->>'observed_at'), '') IS NULL THEN
    RAISE EXCEPTION 'client_health_evidence_invalid';
  END IF;
  BEGIN
    v_observed_at := (p_evidence->>'observed_at')::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'client_health_evidence_time_invalid';
  END;
  IF v_observed_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'client_health_evidence_from_future';
  END IF;

  IF p_actor_type NOT IN ('human', 'service', 'system')
     OR p_authority_tier NOT IN ('system', 'client_success', 'owner') THEN
    RAISE EXCEPTION 'client_health_actor_invalid';
  END IF;
  IF p_actor_type = 'system' THEN
    IF p_actor_id IS NOT NULL OR p_authority_tier <> 'system' THEN
      RAISE EXCEPTION 'client_health_system_actor_invalid';
    END IF;
  ELSIF p_actor_type = 'service' THEN
    IF char_length(btrim(COALESCE(p_actor_id, ''))) NOT BETWEEN 2 AND 160
       OR p_authority_tier NOT IN ('system', 'client_success') THEN
      RAISE EXCEPTION 'client_health_service_actor_invalid';
    END IF;
  ELSE
    IF p_actor_id !~
      '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
      OR p_authority_tier NOT IN ('client_success', 'owner') THEN
      RAISE EXCEPTION 'client_health_human_actor_invalid';
    END IF;
    v_actor_uuid := p_actor_id::uuid;
    IF NOT EXISTS (
      SELECT 1 FROM public.tenant_users tenant_user
       WHERE tenant_user.tenant_id = p_tenant_id
         AND tenant_user.user_id = v_actor_uuid
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'client_health_human_not_tenant_member';
    END IF;
  END IF;

  SELECT control.* INTO v_control
    FROM public.client_health_automation_controls control
   WHERE control.tenant_id = p_tenant_id
   FOR SHARE;
  IF NOT FOUND
     OR v_control.enabled IS DISTINCT FROM true
     OR v_control.execution_mode NOT IN ('shadow', 'supervised') THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'client_health_tenant_not_enabled';
  END IF;
  IF v_control.kill_switch_engaged IS DISTINCT FROM false THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'client_health_kill_switch_engaged';
  END IF;
  IF v_control.revision IS DISTINCT FROM p_expected_control_revision THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'client_health_control_revision_conflict';
  END IF;
  IF v_control.customer_communications_enabled IS DISTINCT FROM false
     OR v_control.provider_actions_enabled IS DISTINCT FROM false THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'client_health_external_action_forbidden';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.customers customer
     WHERE customer.id = p_customer_id
       AND customer.tenant_id = p_tenant_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'client_health_customer_not_found_for_tenant';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      p_tenant_id::text || ':client-health:' || p_customer_id::text
        || ':' || p_intervention_id::text,
      0
    )
  );
  v_evidence_digest := encode(digest(p_evidence::text, 'sha256'), 'hex');
  v_semantic_fingerprint := encode(digest(
    concat_ws('|',
      p_tenant_id::text, p_customer_id::text, p_intervention_id::text,
      p_action, p_expected_revision::text, p_expected_control_revision::text,
      COALESCE(p_signal_snapshot_id::text, ''), COALESCE(p_owner_id::text, ''),
      COALESCE(p_assignee_id::text, ''), COALESCE(p_sla_due_at::text, ''),
      COALESCE(p_action_plan::text, ''), COALESCE(p_escalation_code, ''),
      COALESCE(p_outcome_state, ''), p_actor_type, COALESCE(p_actor_id, ''),
      p_authority_tier, p_evidence::text
    ),
    'sha256'
  ), 'hex');

  SELECT event.* INTO v_existing_event
    FROM public.client_health_intervention_events event
   WHERE event.tenant_id = p_tenant_id
     AND event.idempotency_key = btrim(p_idempotency_key);
  IF FOUND THEN
    IF v_existing_event.customer_id IS DISTINCT FROM p_customer_id
       OR v_existing_event.intervention_id IS DISTINCT FROM p_intervention_id
       OR v_existing_event.action IS DISTINCT FROM p_action
       OR v_existing_event.request_fingerprint IS DISTINCT FROM p_request_fingerprint
       OR v_existing_event.semantic_fingerprint IS DISTINCT FROM v_semantic_fingerprint THEN
      RAISE EXCEPTION USING
        ERRCODE = '23505',
        MESSAGE = 'client_health_idempotency_conflict';
    END IF;
    SELECT intervention.* INTO STRICT v_intervention
      FROM public.client_health_interventions intervention
     WHERE intervention.id = p_intervention_id
       AND intervention.tenant_id = p_tenant_id
       AND intervention.customer_id = p_customer_id;
    RETURN jsonb_build_object(
      'outcome', 'replay',
      'intervention', to_jsonb(v_intervention),
      'event', to_jsonb(v_existing_event)
    );
  END IF;

  IF p_action = 'open_intervention' THEN
    IF p_expected_revision <> 0
       OR p_signal_snapshot_id IS NULL
       OR p_owner_id IS NULL
       OR p_assignee_id IS NULL
       OR p_sla_due_at IS NULL
       OR p_sla_due_at <= v_observed_at
       OR jsonb_typeof(COALESCE(p_action_plan, 'null'::jsonb)) <> 'object'
       OR NULLIF(btrim(p_action_plan->>'objective'), '') IS NULL
       OR NULLIF(btrim(p_action_plan->>'action_type'), '') IS NULL
       OR NULLIF(btrim(p_action_plan->>'success_metric'), '') IS NULL
       OR p_evidence->>'source_type' <> 'intervention_assignment' THEN
      RAISE EXCEPTION 'client_health_open_contract_invalid';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.client_health_signal_snapshots snapshot
       WHERE snapshot.id = p_signal_snapshot_id
         AND snapshot.tenant_id = p_tenant_id
         AND snapshot.customer_id = p_customer_id
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0002',
        MESSAGE = 'client_health_signal_not_found_for_identity';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.tenant_users tenant_user
       WHERE tenant_user.tenant_id = p_tenant_id
         AND tenant_user.user_id = p_owner_id
    ) OR NOT EXISTS (
      SELECT 1 FROM public.tenant_users tenant_user
       WHERE tenant_user.tenant_id = p_tenant_id
         AND tenant_user.user_id = p_assignee_id
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'client_health_assignment_tenant_mismatch';
    END IF;
    INSERT INTO public.client_health_interventions (
      id, tenant_id, customer_id, source_signal_snapshot_id, lifecycle_state,
      revision, owner_id, assignee_id, action_plan, assigned_at, sla_due_at,
      outcome_state, last_action_at
    ) VALUES (
      p_intervention_id, p_tenant_id, p_customer_id, p_signal_snapshot_id,
      'assigned', 0, p_owner_id, p_assignee_id, p_action_plan,
      v_observed_at, p_sla_due_at, 'unknown', v_observed_at
    );
  END IF;

  SELECT intervention.* INTO v_intervention
    FROM public.client_health_interventions intervention
   WHERE intervention.id = p_intervention_id
     AND intervention.tenant_id = p_tenant_id
     AND intervention.customer_id = p_customer_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'client_health_intervention_not_found_for_identity';
  END IF;
  IF v_intervention.revision IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'client_health_revision_conflict';
  END IF;
  IF v_observed_at < v_intervention.assigned_at - interval '5 minutes' THEN
    RAISE EXCEPTION 'client_health_evidence_predates_intervention';
  END IF;

  v_previous_state := v_intervention.lifecycle_state;
  v_next_state := v_previous_state;
  v_previous_outcome_state := v_intervention.outcome_state;
  v_next_outcome_state := v_previous_outcome_state;
  v_accepted_at := v_intervention.accepted_at;
  v_escalated_at := v_intervention.escalated_at;
  v_escalation_code := v_intervention.escalation_code;
  v_action_completed_at := v_intervention.action_completed_at;
  v_completion_evidence_digest := v_intervention.completion_evidence_digest;
  v_outcome_evidence_digest := v_intervention.outcome_evidence_digest;
  v_outcome_observed_at := v_intervention.outcome_observed_at;

  CASE p_action
    WHEN 'open_intervention' THEN
      IF v_previous_state <> 'assigned' OR p_expected_revision <> 0 THEN
        RAISE EXCEPTION 'client_health_transition_invalid';
      END IF;

    WHEN 'accept_assignment' THEN
      IF v_previous_state <> 'assigned'
         OR p_actor_type <> 'human'
         OR v_actor_uuid IS DISTINCT FROM v_intervention.assignee_id
         OR p_evidence->>'source_type' <> 'assignment_acceptance' THEN
        RAISE EXCEPTION 'client_health_acceptance_invalid';
      END IF;
      v_next_state := 'accepted';
      v_next_outcome_state := 'unproven';
      v_accepted_at := v_observed_at;

    WHEN 'escalate' THEN
      IF v_previous_state NOT IN ('assigned', 'accepted')
         OR p_evidence->>'source_type' NOT IN (
           'sla_breach', 'operator_escalation'
         )
         OR p_escalation_code !~ '^[a-z][a-z0-9_]{2,79}$' THEN
        RAISE EXCEPTION 'client_health_escalation_invalid';
      END IF;
      v_next_state := 'escalated';
      v_next_outcome_state := 'unproven';
      v_escalated_at := v_observed_at;
      v_escalation_code := p_escalation_code;

    WHEN 'complete_action' THEN
      IF v_previous_state NOT IN ('accepted', 'escalated')
         OR p_actor_type <> 'human'
         OR (
           v_actor_uuid IS DISTINCT FROM v_intervention.assignee_id
           AND p_authority_tier <> 'owner'
         )
         OR p_evidence->>'source_type' <> 'intervention_completion_receipt' THEN
        RAISE EXCEPTION 'client_health_completion_invalid';
      END IF;
      v_next_state := 'action_completed';
      v_next_outcome_state := 'unproven';
      v_accepted_at := COALESCE(v_accepted_at, v_observed_at);
      v_action_completed_at := v_observed_at;
      v_completion_evidence_digest := v_evidence_digest;

    WHEN 'record_outcome' THEN
      IF v_previous_state <> 'action_completed'
         OR p_outcome_state NOT IN ('improved', 'unchanged', 'worsened')
         OR p_evidence->>'source_type' <> 'client_outcome_receipt'
         OR v_intervention.completion_evidence_digest IS NULL THEN
        RAISE EXCEPTION 'client_health_outcome_evidence_required';
      END IF;
      v_next_state := 'outcome_recorded';
      v_next_outcome_state := p_outcome_state;
      v_outcome_evidence_digest := v_evidence_digest;
      v_outcome_observed_at := v_observed_at;
  END CASE;

  UPDATE public.client_health_interventions
     SET lifecycle_state = v_next_state,
         outcome_state = v_next_outcome_state,
         accepted_at = v_accepted_at,
         escalated_at = v_escalated_at,
         escalation_code = v_escalation_code,
         action_completed_at = v_action_completed_at,
         completion_evidence_digest = v_completion_evidence_digest,
         outcome_evidence_digest = v_outcome_evidence_digest,
         outcome_observed_at = v_outcome_observed_at,
         revision = revision + 1,
         last_action_at = v_observed_at,
         updated_at = now()
   WHERE id = p_intervention_id
     AND tenant_id = p_tenant_id
     AND customer_id = p_customer_id
  RETURNING * INTO v_intervention;

  INSERT INTO public.client_health_intervention_events (
    tenant_id, customer_id, intervention_id, action, previous_state,
    next_state, previous_outcome_state, next_outcome_state, expected_revision,
    resulting_revision, actor_type, actor_id, authority_tier, evidence,
    evidence_digest, target_signal_snapshot_id, request_fingerprint,
    semantic_fingerprint, idempotency_key
  ) VALUES (
    p_tenant_id, p_customer_id, p_intervention_id, p_action, v_previous_state,
    v_next_state, v_previous_outcome_state, v_next_outcome_state,
    p_expected_revision, v_intervention.revision, p_actor_type, p_actor_id,
    p_authority_tier, p_evidence, v_evidence_digest, p_signal_snapshot_id,
    p_request_fingerprint, v_semantic_fingerprint, btrim(p_idempotency_key)
  )
  RETURNING * INTO v_event;

  RETURN jsonb_build_object(
    'outcome', 'applied',
    'intervention', to_jsonb(v_intervention),
    'event', to_jsonb(v_event)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.client_health_kill_switch_rpc(
  p_tenant_id uuid,
  p_expected_control_revision bigint,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_claims text;
  v_calling_role text;
  v_control public.client_health_automation_controls%ROWTYPE;
BEGIN
  v_claims := NULLIF(current_setting('request.jwt.claims', true), '');
  v_calling_role := COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    CASE WHEN v_claims IS NOT NULL THEN v_claims::jsonb ->> 'role' END,
    session_user::text
  );
  IF v_calling_role IS DISTINCT FROM 'service_role'
     OR p_expected_control_revision IS NULL
     OR p_expected_control_revision < 0
     OR char_length(btrim(COALESCE(p_reason, ''))) NOT BETWEEN 3 AND 240 THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'client_health_kill_switch_denied';
  END IF;
  UPDATE public.client_health_automation_controls
     SET enabled = false,
         execution_mode = 'disabled',
         kill_switch_engaged = true,
         revision = revision + 1,
         updated_at = now()
   WHERE tenant_id = p_tenant_id
     AND revision = p_expected_control_revision
  RETURNING * INTO v_control;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'client_health_control_revision_conflict';
  END IF;
  RETURN jsonb_build_object(
    'outcome', 'kill_switch_engaged',
    'tenant_id', v_control.tenant_id,
    'revision', v_control.revision,
    'reason_digest', encode(digest(btrim(p_reason), 'sha256'), 'hex')
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.client_health_signal_snapshot_rpc(
  uuid, uuid, uuid, text, text, jsonb, jsonb, text, text, text, text,
  text, bigint, boolean
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.client_health_signal_snapshot_rpc(
  uuid, uuid, uuid, text, text, jsonb, jsonb, text, text, text, text,
  text, bigint, boolean
) TO service_role;

REVOKE EXECUTE ON FUNCTION public.client_health_intervention_command_rpc(
  uuid, uuid, uuid, text, bigint, text, text, text, text, text, jsonb,
  bigint, boolean, uuid, uuid, uuid, timestamptz, jsonb, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.client_health_intervention_command_rpc(
  uuid, uuid, uuid, text, bigint, text, text, text, text, text, jsonb,
  bigint, boolean, uuid, uuid, uuid, timestamptz, jsonb, text, text
) TO service_role;

REVOKE EXECUTE ON FUNCTION public.client_health_kill_switch_rpc(
  uuid, bigint, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.client_health_kill_switch_rpc(
  uuid, bigint, text
) TO service_role;
