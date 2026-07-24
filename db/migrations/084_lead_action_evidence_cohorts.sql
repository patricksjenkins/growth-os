-- ============================================================================
-- Migration 084: Lead-action completion evidence and conversion cohorts (G20)
-- Date: 2026-07-24
--
-- Additive, default-off, shadow/supervised-only control plane. This migration
-- does not send outreach, contact a provider, rewrite a lead, or backfill
-- historical performance. Cohorts describe observed associations only; they
-- do not claim that an action caused a conversion.
--
-- ROLLBACK: db/rollbacks/084_lead_action_evidence_cohorts_rollback.sql
-- ============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS uq_leads_id_tenant
  ON public.leads (id, tenant_id);

CREATE TABLE IF NOT EXISTS public.lead_action_automation_controls (
  tenant_id                    uuid PRIMARY KEY
                               REFERENCES public.tenants(id) ON DELETE CASCADE,
  enabled                      boolean NOT NULL DEFAULT false,
  execution_mode               text NOT NULL DEFAULT 'disabled'
                               CHECK (execution_mode IN (
                                 'disabled', 'shadow', 'supervised'
                               )),
  kill_switch_engaged          boolean NOT NULL DEFAULT true,
  outreach_enabled             boolean NOT NULL DEFAULT false
                               CHECK (outreach_enabled = false),
  provider_dispatch_enabled    boolean NOT NULL DEFAULT false
                               CHECK (provider_dispatch_enabled = false),
  revision                     bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  activated_by                 uuid,
  activation_evidence          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.lead_actions (
  id                           uuid PRIMARY KEY,
  tenant_id                    uuid NOT NULL,
  lead_id                      uuid NOT NULL,
  action_type                  text NOT NULL
                               CHECK (action_type IN (
                                 'call_review', 'meeting_follow_up',
                                 'proposal_follow_up', 'email_follow_up',
                                 'sms_follow_up', 'qualification',
                                 'sales_task', 'other'
                               )),
  status                       text NOT NULL DEFAULT 'assigned'
                               CHECK (status IN (
                                 'assigned', 'accepted', 'escalated',
                                 'completed', 'outcome_recorded'
                               )),
  revision                     bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  assignee_type                text NOT NULL
                               CHECK (assignee_type IN (
                                 'human', 'agent', 'service'
                               )),
  assignee_id                  text NOT NULL
                               CHECK (char_length(btrim(assignee_id)) BETWEEN 2 AND 160),
  cohort_key                   text NOT NULL
                               CHECK (cohort_key ~ '^[a-z0-9][a-z0-9_.:-]{2,79}$'),
  assignment_source_type       text NOT NULL
                               CHECK (
                                 char_length(assignment_source_type)
                                 BETWEEN 3 AND 80
                               ),
  assignment_source_id         text NOT NULL
                               CHECK (
                                 char_length(assignment_source_id)
                                 BETWEEN 3 AND 240
                               ),
  assigned_at                  timestamptz NOT NULL DEFAULT now(),
  accepted_at                  timestamptz,
  due_at                       timestamptz NOT NULL,
  escalated_at                 timestamptz,
  escalation_code              text
                               CHECK (
                                 escalation_code IS NULL
                                 OR escalation_code ~ '^[a-z][a-z0-9_]{2,79}$'
                               ),
  completed_at                 timestamptz,
  completion_disposition       text
                               CHECK (
                                 completion_disposition IS NULL
                                 OR completion_disposition IN (
                                   'performed', 'not_applicable', 'blocked'
                                 )
                               ),
  outcome_due_at               timestamptz NOT NULL,
  outcome_state                text
                               CHECK (
                                 outcome_state IS NULL
                                 OR outcome_state IN (
                                   'converted', 'not_converted', 'unknown'
                                 )
                               ),
  attribution_state            text
                               CHECK (
                                 attribution_state IS NULL
                                 OR attribution_state IN ('observed', 'unknown')
                               ),
  outcome_source_type          text,
  outcome_source_id            text,
  outcome_recorded_at          timestamptz,
  attribution_model            text
                               CHECK (
                                 attribution_model IS NULL
                                 OR attribution_model =
                                   'descriptive_association_only'
                               ),
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (id, tenant_id, lead_id),
  FOREIGN KEY (lead_id, tenant_id)
    REFERENCES public.leads(id, tenant_id) ON DELETE RESTRICT,
  CHECK (due_at >= assigned_at),
  CHECK (outcome_due_at >= due_at),
  CHECK (
    (status = 'assigned'
      AND accepted_at IS NULL
      AND escalated_at IS NULL
      AND completed_at IS NULL)
    OR
    (status = 'accepted'
      AND accepted_at IS NOT NULL
      AND escalated_at IS NULL
      AND completed_at IS NULL)
    OR
    (status = 'escalated'
      AND escalated_at IS NOT NULL
      AND escalation_code IS NOT NULL
      AND completed_at IS NULL)
    OR
    (status IN ('completed', 'outcome_recorded')
      AND (
        accepted_at IS NOT NULL
        OR (escalated_at IS NOT NULL AND escalation_code IS NOT NULL)
      )
      AND completed_at IS NOT NULL
      AND completion_disposition IS NOT NULL)
  ),
  CHECK (
    (
      outcome_state IS NULL
      AND attribution_state IS NULL
      AND outcome_source_type IS NULL
      AND outcome_source_id IS NULL
      AND outcome_recorded_at IS NULL
      AND attribution_model IS NULL
    )
    OR
    (
      status = 'outcome_recorded'
      AND outcome_state IN ('converted', 'not_converted')
      AND attribution_state = 'observed'
      AND char_length(outcome_source_type) BETWEEN 3 AND 80
      AND char_length(outcome_source_id) BETWEEN 3 AND 240
      AND outcome_recorded_at IS NOT NULL
      AND attribution_model = 'descriptive_association_only'
    )
    OR
    (
      status = 'outcome_recorded'
      AND outcome_state = 'unknown'
      AND attribution_state = 'unknown'
      AND outcome_source_type IS NULL
      AND outcome_source_id IS NULL
      AND outcome_recorded_at IS NOT NULL
      AND attribution_model = 'descriptive_association_only'
    )
  )
);

CREATE TABLE IF NOT EXISTS public.lead_action_receipts (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                    uuid NOT NULL,
  lead_id                      uuid NOT NULL,
  lead_action_id               uuid NOT NULL,
  receipt_type                 text NOT NULL
                               CHECK (receipt_type IN (
                                 'assigned', 'accepted', 'escalated',
                                 'completed', 'outcome_observed',
                                 'outcome_unknown'
                               )),
  previous_status              text,
  resulting_status             text NOT NULL,
  expected_revision            bigint NOT NULL CHECK (expected_revision >= 0),
  resulting_revision           bigint NOT NULL CHECK (resulting_revision > 0),
  actor_type                   text NOT NULL
                               CHECK (actor_type IN (
                                 'human', 'agent', 'service', 'system'
                               )),
  actor_id                     text,
  authority_tier              text NOT NULL
                               CHECK (authority_tier IN (
                                 'system', 'sales_operator',
                                 'department_head', 'owner'
                               )),
  evidence                     jsonb NOT NULL,
  evidence_digest              text NOT NULL
                               CHECK (evidence_digest ~ '^[a-f0-9]{64}$'),
  receipt_payload              jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_fingerprint          text NOT NULL
                               CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  semantic_fingerprint         text NOT NULL
                               CHECK (semantic_fingerprint ~ '^[a-f0-9]{64}$'),
  idempotency_key              text NOT NULL
                               CHECK (
                                 char_length(idempotency_key)
                                 BETWEEN 8 AND 200
                               ),
  occurred_at                  timestamptz NOT NULL DEFAULT now(),
  created_at                   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (lead_action_id, tenant_id, lead_id)
    REFERENCES public.lead_actions(id, tenant_id, lead_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_lead_actions_tenant_lead
  ON public.lead_actions (tenant_id, lead_id, assigned_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_actions_tenant_open_sla
  ON public.lead_actions (tenant_id, due_at, status)
  WHERE status IN ('assigned', 'accepted', 'escalated');
CREATE INDEX IF NOT EXISTS idx_lead_actions_tenant_cohort
  ON public.lead_actions (tenant_id, cohort_key, action_type, assigned_at);
CREATE INDEX IF NOT EXISTS idx_lead_action_receipts_history
  ON public.lead_action_receipts
    (tenant_id, lead_action_id, occurred_at, id);

CREATE OR REPLACE FUNCTION public.lead_action_receipt_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'lead_action_receipt_is_immutable';
END;
$$;

DROP TRIGGER IF EXISTS trg_lead_action_receipts_immutable
  ON public.lead_action_receipts;
CREATE TRIGGER trg_lead_action_receipts_immutable
  BEFORE UPDATE OR DELETE ON public.lead_action_receipts
  FOR EACH ROW EXECUTE FUNCTION public.lead_action_receipt_immutable();

CREATE OR REPLACE FUNCTION public.lead_action_identity_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.lead_id IS DISTINCT FROM OLD.lead_id
     OR NEW.action_type IS DISTINCT FROM OLD.action_type
     OR NEW.assignee_type IS DISTINCT FROM OLD.assignee_type
     OR NEW.assignee_id IS DISTINCT FROM OLD.assignee_id
     OR NEW.cohort_key IS DISTINCT FROM OLD.cohort_key
     OR NEW.assignment_source_type IS DISTINCT FROM OLD.assignment_source_type
     OR NEW.assignment_source_id IS DISTINCT FROM OLD.assignment_source_id
     OR NEW.assigned_at IS DISTINCT FROM OLD.assigned_at
     OR NEW.due_at IS DISTINCT FROM OLD.due_at
     OR NEW.outcome_due_at IS DISTINCT FROM OLD.outcome_due_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'lead_action_identity_is_immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_lead_action_identity_immutable
  ON public.lead_actions;
CREATE TRIGGER trg_lead_action_identity_immutable
  BEFORE UPDATE ON public.lead_actions
  FOR EACH ROW EXECUTE FUNCTION public.lead_action_identity_immutable();

CREATE OR REPLACE FUNCTION public.lead_action_automation_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.kill_switch_engaged = true
     AND NEW.kill_switch_engaged = false THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'lead_action_kill_switch_is_one_way';
  END IF;
  IF NEW.outreach_enabled IS DISTINCT FROM false
     OR NEW.provider_dispatch_enabled IS DISTINCT FROM false THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'lead_action_external_mutation_forbidden';
  END IF;
  IF NEW.enabled = true AND (
    NEW.execution_mode NOT IN ('shadow', 'supervised')
    OR NEW.kill_switch_engaged IS DISTINCT FROM false
    OR NEW.activated_by IS NULL
    OR jsonb_typeof(NEW.activation_evidence) <> 'object'
    OR NEW.activation_evidence = '{}'::jsonb
    OR NOT EXISTS (
      SELECT 1
        FROM public.tenant_users tenant_user
       WHERE tenant_user.tenant_id = NEW.tenant_id
         AND tenant_user.user_id = NEW.activated_by
         AND tenant_user.role IN (
           'owner', 'platform_owner', 'founder', 'admin',
           'client_owner', 'tenant_owner'
         )
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'lead_action_activation_invalid';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_lead_action_automation_guard
  ON public.lead_action_automation_controls;
CREATE TRIGGER trg_lead_action_automation_guard
  BEFORE INSERT OR UPDATE ON public.lead_action_automation_controls
  FOR EACH ROW EXECUTE FUNCTION public.lead_action_automation_guard();

ALTER TABLE public.lead_action_automation_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_action_receipts ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'lead_action_automation_controls',
    'lead_actions',
    'lead_action_receipts'
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
          '''client_owner'', ''tenant_owner'', ''sales'', ''manager''' ||
        ')' ||
      ')',
      'tenant_iso_' || table_name,
      table_name
    );
  END LOOP;
END $$;

GRANT SELECT ON
  public.lead_action_automation_controls,
  public.lead_actions,
  public.lead_action_receipts
TO authenticated, service_role;
REVOKE INSERT, UPDATE, DELETE ON
  public.lead_action_automation_controls,
  public.lead_actions,
  public.lead_action_receipts
FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.lead_action_command_rpc(
  p_tenant_id uuid,
  p_lead_id uuid,
  p_lead_action_id uuid,
  p_action_type text,
  p_command text,
  p_expected_revision bigint,
  p_idempotency_key text,
  p_request_fingerprint text,
  p_actor_type text,
  p_actor_id text,
  p_authority_tier text,
  p_evidence jsonb,
  p_feature_gate_enabled boolean DEFAULT false,
  p_assignee_type text DEFAULT NULL,
  p_assignee_id text DEFAULT NULL,
  p_due_at timestamptz DEFAULT NULL,
  p_outcome_due_at timestamptz DEFAULT NULL,
  p_cohort_key text DEFAULT NULL,
  p_assignment_source_type text DEFAULT NULL,
  p_assignment_source_id text DEFAULT NULL,
  p_escalation_code text DEFAULT NULL,
  p_completion_disposition text DEFAULT NULL,
  p_outcome_state text DEFAULT NULL,
  p_attribution_state text DEFAULT NULL,
  p_outcome_source_type text DEFAULT NULL,
  p_outcome_source_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_claims text;
  v_calling_role text;
  v_control public.lead_action_automation_controls%ROWTYPE;
  v_action public.lead_actions%ROWTYPE;
  v_receipt public.lead_action_receipts%ROWTYPE;
  v_existing_receipt public.lead_action_receipts%ROWTYPE;
  v_previous_status text;
  v_resulting_status text;
  v_receipt_type text;
  v_evidence_observed_at timestamptz;
  v_evidence_digest text;
  v_semantic_fingerprint text;
  v_receipt_payload jsonb;
  v_actor_uuid uuid;
  v_assignee_uuid uuid;
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
      MESSAGE = 'lead_action_requires_service_role';
  END IF;
  IF p_feature_gate_enabled IS DISTINCT FROM true THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'lead_action_writes_disabled';
  END IF;
  IF p_tenant_id IS NULL OR p_lead_id IS NULL OR p_lead_action_id IS NULL THEN
    RAISE EXCEPTION 'lead_action_exact_identity_required';
  END IF;
  IF COALESCE(p_action_type, '') NOT IN (
    'call_review', 'meeting_follow_up', 'proposal_follow_up',
    'email_follow_up', 'sms_follow_up', 'qualification',
    'sales_task', 'other'
  ) OR COALESCE(p_command, '') NOT IN (
    'assign', 'accept', 'escalate', 'complete', 'record_outcome'
  ) THEN
    RAISE EXCEPTION 'lead_action_command_invalid';
  END IF;
  IF p_expected_revision IS NULL OR p_expected_revision < 0 THEN
    RAISE EXCEPTION 'lead_action_revision_invalid';
  END IF;
  IF p_command <> 'assign' AND (
    p_assignee_type IS NOT NULL
    OR p_assignee_id IS NOT NULL
    OR p_due_at IS NOT NULL
    OR p_outcome_due_at IS NOT NULL
    OR p_cohort_key IS NOT NULL
    OR p_assignment_source_type IS NOT NULL
    OR p_assignment_source_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'lead_action_assignment_fields_forbidden';
  END IF;
  IF p_command <> 'escalate' AND p_escalation_code IS NOT NULL THEN
    RAISE EXCEPTION 'lead_action_escalation_fields_forbidden';
  END IF;
  IF p_command <> 'complete' AND p_completion_disposition IS NOT NULL THEN
    RAISE EXCEPTION 'lead_action_completion_fields_forbidden';
  END IF;
  IF p_command <> 'record_outcome' AND (
    p_outcome_state IS NOT NULL
    OR p_attribution_state IS NOT NULL
    OR p_outcome_source_type IS NOT NULL
    OR p_outcome_source_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'lead_action_outcome_fields_forbidden';
  END IF;
  IF char_length(btrim(COALESCE(p_idempotency_key, ''))) NOT BETWEEN 8 AND 200
     OR COALESCE(p_request_fingerprint, '') !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'lead_action_idempotency_invalid';
  END IF;
  IF jsonb_typeof(COALESCE(p_evidence, 'null'::jsonb)) <> 'object'
     OR p_evidence = '{}'::jsonb
     OR char_length(btrim(COALESCE(p_evidence->>'source_type', '')))
        NOT BETWEEN 3 AND 80
     OR char_length(btrim(COALESCE(p_evidence->>'source_id', '')))
        NOT BETWEEN 3 AND 240
     OR NULLIF(btrim(COALESCE(p_evidence->>'observed_at', '')), '') IS NULL
     OR p_evidence::text ~* (
       '"(causal|caused_by|causedBy|causal_effect|causalEffect|'
       'incremental_lift|incrementalLift|customer_email|customerEmail|'
       'customer_phone|customerPhone|message_body|messageBody|'
       'provider_payload|providerPayload|provider_token|providerToken)"'
       '[[:space:]]*:'
     ) THEN
    RAISE EXCEPTION 'lead_action_evidence_invalid';
  END IF;
  BEGIN
    v_evidence_observed_at := (p_evidence->>'observed_at')::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'lead_action_evidence_time_invalid';
  END;
  IF v_evidence_observed_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'lead_action_evidence_from_future';
  END IF;

  v_evidence_digest := encode(
    digest(convert_to(p_evidence::text, 'UTF8'), 'sha256'),
    'hex'
  );
  v_semantic_fingerprint := encode(
    digest(
      convert_to(
        jsonb_build_object(
          'tenant_id', p_tenant_id,
          'lead_id', p_lead_id,
          'lead_action_id', p_lead_action_id,
          'action_type', p_action_type,
          'command', p_command,
          'expected_revision', p_expected_revision,
          'actor_type', p_actor_type,
          'actor_id', p_actor_id,
          'authority_tier', p_authority_tier,
          'evidence_digest', v_evidence_digest,
          'assignee_type', p_assignee_type,
          'assignee_id', p_assignee_id,
          'due_at', p_due_at,
          'outcome_due_at', p_outcome_due_at,
          'cohort_key', p_cohort_key,
          'assignment_source_type', p_assignment_source_type,
          'assignment_source_id', p_assignment_source_id,
          'escalation_code', p_escalation_code,
          'completion_disposition', p_completion_disposition,
          'outcome_state', p_outcome_state,
          'attribution_state', p_attribution_state,
          'outcome_source_type', p_outcome_source_type,
          'outcome_source_id', p_outcome_source_id
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );

  SELECT receipt.*
    INTO v_existing_receipt
    FROM public.lead_action_receipts receipt
   WHERE receipt.tenant_id = p_tenant_id
     AND receipt.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing_receipt.request_fingerprint IS DISTINCT FROM
         p_request_fingerprint
       OR v_existing_receipt.semantic_fingerprint IS DISTINCT FROM
         v_semantic_fingerprint THEN
      RAISE EXCEPTION USING
        ERRCODE = '23505',
        MESSAGE = 'lead_action_idempotency_conflict';
    END IF;
    RETURN jsonb_build_object(
      'outcome', 'replay',
      'action', (
        SELECT to_jsonb(existing_action)
          FROM public.lead_actions existing_action
         WHERE existing_action.id = p_lead_action_id
           AND existing_action.tenant_id = p_tenant_id
           AND existing_action.lead_id = p_lead_id
      ),
      'receipt', to_jsonb(v_existing_receipt)
    );
  END IF;

  SELECT control.*
    INTO v_control
    FROM public.lead_action_automation_controls control
   WHERE control.tenant_id = p_tenant_id;
  IF NOT FOUND
     OR v_control.enabled IS DISTINCT FROM true
     OR v_control.execution_mode NOT IN ('shadow', 'supervised')
     OR v_control.kill_switch_engaged IS DISTINCT FROM false THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'lead_action_kill_switch_engaged';
  END IF;
  IF v_control.outreach_enabled IS DISTINCT FROM false
     OR v_control.provider_dispatch_enabled IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'lead_action_external_mutation_forbidden';
  END IF;

  IF COALESCE(p_actor_type, '') NOT IN (
       'human', 'agent', 'service', 'system'
     )
     OR COALESCE(p_authority_tier, '') NOT IN (
       'system', 'sales_operator', 'department_head', 'owner'
     ) THEN
    RAISE EXCEPTION 'lead_action_actor_invalid';
  END IF;
  IF p_actor_type = 'human' THEN
    BEGIN
      v_actor_uuid := p_actor_id::uuid;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'lead_action_human_actor_invalid';
    END;
    IF NOT EXISTS (
      SELECT 1
        FROM public.tenant_users tenant_user
       WHERE tenant_user.tenant_id = p_tenant_id
         AND tenant_user.user_id = v_actor_uuid
    ) THEN
      RAISE EXCEPTION 'lead_action_human_actor_tenant_mismatch';
    END IF;
  ELSIF p_actor_type IN ('agent', 'service') THEN
    IF char_length(btrim(COALESCE(p_actor_id, ''))) NOT BETWEEN 2 AND 160
       OR p_authority_tier = 'owner' THEN
      RAISE EXCEPTION 'lead_action_service_actor_invalid';
    END IF;
  ELSIF p_actor_id IS NOT NULL OR p_authority_tier <> 'system' THEN
    RAISE EXCEPTION 'lead_action_system_actor_invalid';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.leads lead
     WHERE lead.id = p_lead_id
       AND lead.tenant_id = p_tenant_id
  ) THEN
    RAISE EXCEPTION 'lead_action_lead_tenant_mismatch';
  END IF;

  IF p_command = 'assign' THEN
    IF p_expected_revision <> 0 THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'lead_action_revision_conflict';
    END IF;
    IF EXISTS (
      SELECT 1
        FROM public.lead_actions existing_action
       WHERE existing_action.id = p_lead_action_id
    ) THEN
      RAISE EXCEPTION 'lead_action_identity_already_exists';
    END IF;
    IF COALESCE(p_assignee_type, '') NOT IN ('human', 'agent', 'service')
       OR char_length(btrim(COALESCE(p_assignee_id, '')))
          NOT BETWEEN 2 AND 160
       OR p_due_at IS NULL
       OR p_due_at < now()
       OR p_outcome_due_at IS NULL
       OR p_outcome_due_at < p_due_at
       OR COALESCE(p_cohort_key, '')
          !~ '^[a-z0-9][a-z0-9_.:-]{2,79}$'
       OR char_length(btrim(COALESCE(p_assignment_source_type, '')))
          NOT BETWEEN 3 AND 80
       OR char_length(btrim(COALESCE(p_assignment_source_id, '')))
          NOT BETWEEN 3 AND 240 THEN
      RAISE EXCEPTION 'lead_action_assignment_contract_invalid';
    END IF;
    IF p_assignee_type = 'human' THEN
      BEGIN
        v_assignee_uuid := p_assignee_id::uuid;
      EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'lead_action_assignee_invalid';
      END;
      IF NOT EXISTS (
        SELECT 1
          FROM public.tenant_users tenant_user
         WHERE tenant_user.tenant_id = p_tenant_id
           AND tenant_user.user_id = v_assignee_uuid
      ) THEN
        RAISE EXCEPTION 'lead_action_assignee_tenant_mismatch';
      END IF;
    END IF;
    INSERT INTO public.lead_actions (
      id, tenant_id, lead_id, action_type, status, revision,
      assignee_type, assignee_id, cohort_key,
      assignment_source_type, assignment_source_id,
      due_at, outcome_due_at
    ) VALUES (
      p_lead_action_id, p_tenant_id, p_lead_id, p_action_type,
      'assigned', 1, p_assignee_type, p_assignee_id, p_cohort_key,
      p_assignment_source_type, p_assignment_source_id,
      p_due_at, p_outcome_due_at
    )
    RETURNING * INTO v_action;
    v_previous_status := NULL;
    v_resulting_status := 'assigned';
    v_receipt_type := 'assigned';
    v_receipt_payload := jsonb_build_object(
      'assignee_type', p_assignee_type,
      'assignee_id', p_assignee_id,
      'due_at', p_due_at,
      'outcome_due_at', p_outcome_due_at,
      'cohort_key', p_cohort_key,
      'assignment_source_type', p_assignment_source_type,
      'assignment_source_id', p_assignment_source_id
    );
  ELSE
    SELECT action.*
      INTO v_action
      FROM public.lead_actions action
     WHERE action.id = p_lead_action_id
       AND action.tenant_id = p_tenant_id
       AND action.lead_id = p_lead_id
       AND action.action_type = p_action_type
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'lead_action_exact_identity_not_found';
    END IF;
    IF v_action.revision IS DISTINCT FROM p_expected_revision THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'lead_action_revision_conflict';
    END IF;
    v_previous_status := v_action.status;

    IF p_command = 'accept' THEN
      IF v_action.status <> 'assigned'
         OR p_actor_type IS DISTINCT FROM v_action.assignee_type
         OR p_actor_id IS DISTINCT FROM v_action.assignee_id THEN
        RAISE EXCEPTION 'lead_action_acceptance_contract_invalid';
      END IF;
      UPDATE public.lead_actions
         SET status = 'accepted',
             accepted_at = now(),
             revision = revision + 1,
             updated_at = now()
       WHERE id = p_lead_action_id
         AND tenant_id = p_tenant_id
         AND lead_id = p_lead_id
      RETURNING * INTO v_action;
      v_resulting_status := 'accepted';
      v_receipt_type := 'accepted';
      v_receipt_payload := jsonb_build_object(
        'accepted_by', p_actor_id,
        'sla_due_at', v_action.due_at
      );
    ELSIF p_command = 'escalate' THEN
      IF v_action.status NOT IN ('assigned', 'accepted')
         OR COALESCE(p_escalation_code, '')
            !~ '^[a-z][a-z0-9_]{2,79}$'
         OR (
           now() < v_action.due_at
           AND NOT (
             p_actor_type = 'human'
             AND p_authority_tier = 'owner'
             AND p_evidence->>'source_type' = 'manual_escalation'
           )
         ) THEN
        RAISE EXCEPTION 'lead_action_escalation_contract_invalid';
      END IF;
      UPDATE public.lead_actions
         SET status = 'escalated',
             escalated_at = now(),
             escalation_code = p_escalation_code,
             revision = revision + 1,
             updated_at = now()
       WHERE id = p_lead_action_id
         AND tenant_id = p_tenant_id
         AND lead_id = p_lead_id
      RETURNING * INTO v_action;
      v_resulting_status := 'escalated';
      v_receipt_type := 'escalated';
      v_receipt_payload := jsonb_build_object(
        'escalation_code', p_escalation_code,
        'sla_due_at', v_action.due_at,
        'escalated_after_due',
          v_action.escalated_at >= v_action.due_at
      );
    ELSIF p_command = 'complete' THEN
      IF v_action.status NOT IN ('accepted', 'escalated')
         OR COALESCE(p_completion_disposition, '') NOT IN (
           'performed', 'not_applicable', 'blocked'
         )
         OR (
           p_actor_type IS DISTINCT FROM v_action.assignee_type
           OR p_actor_id IS DISTINCT FROM v_action.assignee_id
         )
         AND NOT (
           p_actor_type = 'human'
           AND p_authority_tier = 'owner'
         )
         THEN
        RAISE EXCEPTION 'lead_action_completion_contract_invalid';
      END IF;
      UPDATE public.lead_actions
         SET status = 'completed',
             completed_at = now(),
             completion_disposition = p_completion_disposition,
             revision = revision + 1,
             updated_at = now()
       WHERE id = p_lead_action_id
         AND tenant_id = p_tenant_id
         AND lead_id = p_lead_id
      RETURNING * INTO v_action;
      v_resulting_status := 'completed';
      v_receipt_type := 'completed';
      v_receipt_payload := jsonb_build_object(
        'completion_disposition', p_completion_disposition,
        'completed_by', p_actor_id,
        'completed_within_sla', v_action.completed_at <= v_action.due_at
      );
    ELSE
      IF v_action.status <> 'completed'
         OR v_action.outcome_state IS NOT NULL
         OR COALESCE(p_outcome_state, '') NOT IN (
           'converted', 'not_converted', 'unknown'
         ) THEN
        RAISE EXCEPTION 'lead_action_outcome_contract_invalid';
      END IF;
      IF p_outcome_state IN ('converted', 'not_converted') THEN
        IF p_attribution_state IS DISTINCT FROM 'observed'
           OR char_length(btrim(COALESCE(p_outcome_source_type, '')))
              NOT BETWEEN 3 AND 80
           OR char_length(btrim(COALESCE(p_outcome_source_id, '')))
              NOT BETWEEN 3 AND 240 THEN
          RAISE EXCEPTION 'lead_action_observed_attribution_invalid';
        END IF;
        v_receipt_type := 'outcome_observed';
      ELSE
        IF p_attribution_state IS DISTINCT FROM 'unknown'
           OR p_outcome_source_type IS NOT NULL
           OR p_outcome_source_id IS NOT NULL
           OR now() < v_action.outcome_due_at THEN
          RAISE EXCEPTION 'lead_action_unknown_outcome_invalid';
        END IF;
        v_receipt_type := 'outcome_unknown';
      END IF;
      UPDATE public.lead_actions
         SET status = 'outcome_recorded',
             outcome_state = p_outcome_state,
             attribution_state = p_attribution_state,
             outcome_source_type = p_outcome_source_type,
             outcome_source_id = p_outcome_source_id,
             outcome_recorded_at = now(),
             attribution_model = 'descriptive_association_only',
             revision = revision + 1,
             updated_at = now()
       WHERE id = p_lead_action_id
         AND tenant_id = p_tenant_id
         AND lead_id = p_lead_id
      RETURNING * INTO v_action;
      v_resulting_status := 'outcome_recorded';
      v_receipt_payload := jsonb_build_object(
        'outcome_state', p_outcome_state,
        'attribution_state', p_attribution_state,
        'outcome_source_type', p_outcome_source_type,
        'outcome_source_id', p_outcome_source_id,
        'attribution_model', 'descriptive_association_only'
      );
    END IF;
  END IF;

  INSERT INTO public.lead_action_receipts (
    tenant_id, lead_id, lead_action_id, receipt_type,
    previous_status, resulting_status, expected_revision,
    resulting_revision, actor_type, actor_id, authority_tier,
    evidence, evidence_digest, receipt_payload,
    request_fingerprint, semantic_fingerprint, idempotency_key
  ) VALUES (
    p_tenant_id, p_lead_id, p_lead_action_id, v_receipt_type,
    v_previous_status, v_resulting_status, p_expected_revision,
    v_action.revision, p_actor_type, p_actor_id, p_authority_tier,
    p_evidence, v_evidence_digest, v_receipt_payload,
    p_request_fingerprint, v_semantic_fingerprint, p_idempotency_key
  )
  RETURNING * INTO v_receipt;

  RETURN jsonb_build_object(
    'outcome', 'applied',
    'action', to_jsonb(v_action),
    'receipt', to_jsonb(v_receipt)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.lead_action_command_rpc(
  uuid, uuid, uuid, text, text, bigint, text, text, text, text, text,
  jsonb, boolean, text, text, timestamptz, timestamptz, text, text,
  text, text, text, text, text, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lead_action_command_rpc(
  uuid, uuid, uuid, text, text, bigint, text, text, text, text, text,
  jsonb, boolean, text, text, timestamptz, timestamptz, text, text,
  text, text, text, text, text, text, text
) TO service_role;

CREATE OR REPLACE FUNCTION public.lead_action_kill_switch_rpc(
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
  v_reason_digest text;
  v_resulting_revision bigint;
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
      MESSAGE = 'lead_action_requires_service_role';
  END IF;
  IF p_tenant_id IS NULL
     OR char_length(btrim(COALESCE(p_reason, ''))) NOT BETWEEN 8 AND 240 THEN
    RAISE EXCEPTION 'lead_action_kill_switch_reason_required';
  END IF;
  v_reason_digest := encode(
    digest(convert_to(p_reason, 'UTF8'), 'sha256'),
    'hex'
  );
  UPDATE public.lead_action_automation_controls
     SET enabled = false,
         execution_mode = 'disabled',
         kill_switch_engaged = true,
         revision = revision + 1,
         activation_evidence =
           (activation_evidence - 'kill_switch_reason')
           || jsonb_build_object(
           'kill_switch_reason_digest', v_reason_digest,
           'kill_switch_engaged_at', now()
         ),
         updated_at = now()
   WHERE tenant_id = p_tenant_id
  RETURNING revision INTO v_resulting_revision;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lead_action_control_not_found';
  END IF;
  RETURN jsonb_build_object(
    'outcome', 'contained',
    'tenant_id', p_tenant_id,
    'revision', v_resulting_revision,
    'reason_digest', v_reason_digest
  );
END;
$$;

REVOKE ALL ON FUNCTION public.lead_action_kill_switch_rpc(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lead_action_kill_switch_rpc(uuid, text)
  TO service_role;

CREATE OR REPLACE VIEW public.lead_action_conversion_cohorts
WITH (security_invoker = true)
AS
SELECT
  action.tenant_id,
  date_trunc('month', action.assigned_at)::date AS cohort_month,
  action.cohort_key,
  action.action_type,
  count(*)::bigint AS assigned_count,
  count(*) FILTER (
    WHERE action.status IN ('completed', 'outcome_recorded')
  )::bigint AS completed_count,
  count(*) FILTER (
    WHERE action.outcome_state IN ('converted', 'not_converted')
  )::bigint AS observed_outcome_count,
  count(*) FILTER (
    WHERE action.outcome_state = 'unknown'
  )::bigint AS unknown_outcome_count,
  count(*) FILTER (
    WHERE action.outcome_state IS NULL
  )::bigint AS pending_outcome_count,
  count(*) FILTER (
    WHERE action.outcome_state = 'converted'
  )::bigint AS converted_count,
  count(*) FILTER (
    WHERE action.outcome_state = 'not_converted'
  )::bigint AS not_converted_count,
  CASE
    WHEN count(*) FILTER (
      WHERE action.outcome_state IN ('converted', 'not_converted')
    ) = 0 THEN NULL
    ELSE round(
      count(*) FILTER (
        WHERE action.outcome_state = 'converted'
      )::numeric
      /
      count(*) FILTER (
        WHERE action.outcome_state IN ('converted', 'not_converted')
      )::numeric,
      6
    )
  END AS observed_conversion_rate,
  min(action.assigned_at) AS evidence_window_started_at,
  max(action.outcome_recorded_at) AS evidence_window_ended_at,
  'descriptive_association_only'::text AS attribution_model,
  false AS causal_claim
FROM public.lead_actions action
GROUP BY
  action.tenant_id,
  date_trunc('month', action.assigned_at)::date,
  action.cohort_key,
  action.action_type;

GRANT SELECT ON public.lead_action_conversion_cohorts
  TO authenticated, service_role;
