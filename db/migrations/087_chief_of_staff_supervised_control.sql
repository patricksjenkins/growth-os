-- ============================================================================
-- Migration 087: Supervised Chief of Staff control foundation
-- Date: 2026-07-24
--
-- Additive, default-off, read-only/shadow foundation. It coordinates evidence;
-- it cannot execute production writes, provider dispatch, communications, or
-- financial actions. A coordination cycle cannot open unless accepted
-- Reliability and Revenue reports for the exact reporting window each use an
-- accepted versioned report contract.
--
-- ROLLBACK: db/rollbacks/087_chief_of_staff_supervised_control_rollback.sql
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.cos_supervision_controls (
  tenant_id                       uuid PRIMARY KEY
                                  REFERENCES public.tenants(id) ON DELETE CASCADE,
  enabled                         boolean NOT NULL DEFAULT false,
  execution_mode                  text NOT NULL DEFAULT 'disabled'
                                  CHECK (execution_mode IN (
                                    'disabled', 'shadow', 'supervised'
                                  )),
  read_only                       boolean NOT NULL DEFAULT true
                                  CHECK (read_only = true),
  kill_switch_engaged             boolean NOT NULL DEFAULT true,
  production_write_enabled        boolean NOT NULL DEFAULT false
                                  CHECK (production_write_enabled = false),
  provider_dispatch_enabled       boolean NOT NULL DEFAULT false
                                  CHECK (provider_dispatch_enabled = false),
  customer_communication_enabled boolean NOT NULL DEFAULT false
                                  CHECK (customer_communication_enabled = false),
  financial_action_enabled        boolean NOT NULL DEFAULT false
                                  CHECK (financial_action_enabled = false),
  revision                        bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  activated_by                    uuid,
  activation_evidence             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.department_report_contracts (
  id                              uuid PRIMARY KEY,
  tenant_id                       uuid NOT NULL
                                  REFERENCES public.tenants(id) ON DELETE RESTRICT,
  department                      text NOT NULL
                                  CHECK (department IN (
                                    'reliability_security_agent_ops',
                                    'revenue_sales',
                                    'onboarding_implementation',
                                    'client_success_support',
                                    'finance_data_governance',
                                    'marketing_brand',
                                    'product_engineering'
                                  )),
  contract_version                integer NOT NULL CHECK (contract_version > 0),
  schema_digest                   text NOT NULL
                                  CHECK (schema_digest ~ '^[a-f0-9]{64}$'),
  acceptance_state                text NOT NULL DEFAULT 'draft'
                                  CHECK (acceptance_state IN (
                                    'draft', 'accepted', 'retired'
                                  )),
  revision                        bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  accepted_by                     uuid,
  accepted_at                     timestamptz,
  acceptance_evidence_digest      text
                                  CHECK (
                                    acceptance_evidence_digest IS NULL
                                    OR acceptance_evidence_digest ~ '^[a-f0-9]{64}$'
                                  ),
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (id, tenant_id, department),
  UNIQUE (tenant_id, department, contract_version),
  CHECK (
    (acceptance_state = 'draft'
      AND accepted_by IS NULL
      AND accepted_at IS NULL
      AND acceptance_evidence_digest IS NULL)
    OR
    (acceptance_state IN ('accepted', 'retired')
      AND accepted_by IS NOT NULL
      AND accepted_at IS NOT NULL
      AND acceptance_evidence_digest IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS public.department_reports (
  id                              uuid PRIMARY KEY,
  tenant_id                       uuid NOT NULL,
  department_report_contract_id   uuid NOT NULL,
  source_reliability_report_id    uuid,
  source_revenue_report_id        uuid,
  department                      text NOT NULL,
  reporting_period_start          date NOT NULL,
  reporting_period_end            date NOT NULL,
  report_digest                   text NOT NULL
                                  CHECK (report_digest ~ '^[a-f0-9]{64}$'),
  report_state                    text NOT NULL DEFAULT 'submitted'
                                  CHECK (report_state IN (
                                    'submitted', 'accepted', 'rejected'
                                  )),
  revision                        bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  outcome_health                  text NOT NULL
                                  CHECK (outcome_health IN (
                                    'healthy', 'at_risk', 'unhealthy', 'unknown'
                                  )),
  structured_summary              jsonb NOT NULL DEFAULT '{}'::jsonb,
  submitted_at                    timestamptz NOT NULL DEFAULT now(),
  accepted_by                     uuid,
  accepted_at                     timestamptz,
  acceptance_evidence_digest      text
                                  CHECK (
                                    acceptance_evidence_digest IS NULL
                                    OR acceptance_evidence_digest ~ '^[a-f0-9]{64}$'
                                  ),
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (
    tenant_id, department_report_contract_id,
    reporting_period_start, reporting_period_end
  ),
  FOREIGN KEY (department_report_contract_id, tenant_id)
    REFERENCES public.department_report_contracts(id, tenant_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (department_report_contract_id, tenant_id, department)
    REFERENCES public.department_report_contracts(id, tenant_id, department)
    ON DELETE RESTRICT,
  FOREIGN KEY (source_reliability_report_id, tenant_id)
    REFERENCES public.reliability_head_reports(id, tenant_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (source_revenue_report_id, tenant_id)
    REFERENCES public.revenue_head_reports(id, tenant_id)
    ON DELETE RESTRICT,
  CHECK (reporting_period_end >= reporting_period_start),
  CHECK (
    (
      department = 'reliability_security_agent_ops'
      AND source_reliability_report_id IS NOT NULL
      AND source_revenue_report_id IS NULL
    )
    OR
    (
      department = 'revenue_sales'
      AND source_reliability_report_id IS NULL
      AND source_revenue_report_id IS NOT NULL
    )
    OR
    (
      department NOT IN (
        'reliability_security_agent_ops', 'revenue_sales'
      )
      AND source_reliability_report_id IS NULL
      AND source_revenue_report_id IS NULL
    )
  ),
  CHECK (
    (report_state = 'submitted'
      AND accepted_by IS NULL
      AND accepted_at IS NULL
      AND acceptance_evidence_digest IS NULL)
    OR
    (report_state IN ('accepted', 'rejected')
      AND accepted_by IS NOT NULL
      AND accepted_at IS NOT NULL
      AND acceptance_evidence_digest IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS public.cos_coordination_cycles (
  id                              uuid PRIMARY KEY,
  tenant_id                       uuid NOT NULL
                                  REFERENCES public.tenants(id) ON DELETE RESTRICT,
  reporting_period_start          date NOT NULL,
  reporting_period_end            date NOT NULL,
  reliability_report_id           uuid NOT NULL,
  revenue_report_id               uuid NOT NULL,
  coordination_state              text NOT NULL DEFAULT 'supervised_open'
                                  CHECK (coordination_state IN (
                                    'supervised_open', 'supervised_closed'
                                  )),
  revision                        bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  opened_at                       timestamptz NOT NULL DEFAULT now(),
  closed_at                       timestamptz,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, reporting_period_start, reporting_period_end),
  FOREIGN KEY (reliability_report_id, tenant_id)
    REFERENCES public.department_reports(id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (revenue_report_id, tenant_id)
    REFERENCES public.department_reports(id, tenant_id) ON DELETE RESTRICT,
  CHECK (reporting_period_end >= reporting_period_start),
  CHECK (reliability_report_id <> revenue_report_id),
  CHECK (
    (coordination_state = 'supervised_open' AND closed_at IS NULL)
    OR
    (coordination_state = 'supervised_closed' AND closed_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS public.cos_coordination_records (
  id                              uuid PRIMARY KEY,
  tenant_id                       uuid NOT NULL,
  cos_coordination_cycle_id       uuid NOT NULL,
  record_type                     text NOT NULL
                                  CHECK (record_type IN (
                                    'company_goal', 'dependency',
                                    'capacity_conflict', 'decision_required',
                                    'exception', 'follow_through'
                                  )),
  status                          text NOT NULL
                                  CHECK (status IN (
                                    'active', 'at_risk', 'blocked', 'achieved',
                                    'open', 'resolved', 'pending', 'decided',
                                    'assigned', 'accepted', 'escalated',
                                    'completed'
                                  )),
  revision                        bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  title                           text NOT NULL
                                  CHECK (char_length(btrim(title)) BETWEEN 3 AND 240),
  department                      text,
  owner_type                      text NOT NULL
                                  CHECK (owner_type IN ('human', 'agent', 'service')),
  owner_id                        text NOT NULL
                                  CHECK (char_length(btrim(owner_id)) BETWEEN 2 AND 160),
  source_goal_id                  uuid,
  target_goal_id                  uuid,
  record_payload                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  due_at                          timestamptz,
  accepted_at                     timestamptz,
  escalated_at                    timestamptz,
  completed_at                    timestamptz,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (id, tenant_id, cos_coordination_cycle_id),
  FOREIGN KEY (cos_coordination_cycle_id, tenant_id)
    REFERENCES public.cos_coordination_cycles(id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_goal_id, tenant_id, cos_coordination_cycle_id)
    REFERENCES public.cos_coordination_records(
      id, tenant_id, cos_coordination_cycle_id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (target_goal_id, tenant_id, cos_coordination_cycle_id)
    REFERENCES public.cos_coordination_records(
      id, tenant_id, cos_coordination_cycle_id
    ) ON DELETE RESTRICT,
  CHECK (
    (record_type = 'dependency'
      AND source_goal_id IS NOT NULL
      AND target_goal_id IS NOT NULL
      AND source_goal_id <> target_goal_id)
    OR
    (record_type <> 'dependency'
      AND source_goal_id IS NULL
      AND target_goal_id IS NULL)
  ),
  CHECK (
    record_type <> 'follow_through'
    OR due_at IS NOT NULL
  ),
  CHECK (
    (status = 'assigned'
      AND accepted_at IS NULL
      AND escalated_at IS NULL
      AND completed_at IS NULL)
    OR status <> 'assigned'
  ),
  CHECK (
    (status = 'accepted'
      AND accepted_at IS NOT NULL
      AND escalated_at IS NULL
      AND completed_at IS NULL)
    OR status <> 'accepted'
  ),
  CHECK (
    (status = 'escalated'
      AND escalated_at IS NOT NULL
      AND completed_at IS NULL)
    OR status <> 'escalated'
  ),
  CHECK (
    (status = 'completed'
      AND completed_at IS NOT NULL)
    OR status <> 'completed'
  )
);

CREATE TABLE IF NOT EXISTS public.cos_supervised_events (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                       uuid NOT NULL,
  entity_type                     text NOT NULL
                                  CHECK (entity_type IN (
                                    'report_contract', 'department_report',
                                    'coordination_cycle', 'coordination_record'
                                  )),
  entity_id                       uuid NOT NULL,
  command                         text NOT NULL,
  previous_state                  text,
  resulting_state                 text NOT NULL,
  expected_revision               bigint NOT NULL CHECK (expected_revision >= 0),
  resulting_revision              bigint NOT NULL CHECK (resulting_revision > 0),
  actor_type                      text NOT NULL
                                  CHECK (actor_type IN (
                                    'human', 'agent', 'service', 'system'
                                  )),
  actor_id                        text,
  authority_tier                 text NOT NULL
                                  CHECK (authority_tier IN (
                                    'system', 'department_head',
                                    'chief_of_staff', 'owner'
                                  )),
  evidence                        jsonb NOT NULL,
  evidence_digest                 text NOT NULL
                                  CHECK (evidence_digest ~ '^[a-f0-9]{64}$'),
  request_fingerprint             text NOT NULL
                                  CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  semantic_fingerprint            text NOT NULL
                                  CHECK (semantic_fingerprint ~ '^[a-f0-9]{64}$'),
  idempotency_key                 text NOT NULL
                                  CHECK (
                                    char_length(idempotency_key)
                                    BETWEEN 8 AND 200
                                  ),
  created_at                      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_department_reports_gate
  ON public.department_reports (
    tenant_id, department, reporting_period_start,
    reporting_period_end, report_state
  );
CREATE INDEX IF NOT EXISTS idx_cos_records_type_status
  ON public.cos_coordination_records (
    tenant_id, cos_coordination_cycle_id, record_type, status, due_at
  );
CREATE INDEX IF NOT EXISTS idx_cos_events_entity
  ON public.cos_supervised_events (tenant_id, entity_type, entity_id, created_at);

CREATE OR REPLACE FUNCTION public.cos_immutable_event()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'cos_supervised_event_is_immutable';
END;
$$;

DROP TRIGGER IF EXISTS trg_cos_supervised_events_immutable
  ON public.cos_supervised_events;
CREATE TRIGGER trg_cos_supervised_events_immutable
  BEFORE UPDATE OR DELETE ON public.cos_supervised_events
  FOR EACH ROW EXECUTE FUNCTION public.cos_immutable_event();

CREATE OR REPLACE FUNCTION public.cos_control_guard()
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
      MESSAGE = 'cos_kill_switch_is_one_way';
  END IF;
  IF NEW.read_only IS DISTINCT FROM true
     OR NEW.production_write_enabled IS DISTINCT FROM false
     OR NEW.provider_dispatch_enabled IS DISTINCT FROM false
     OR NEW.customer_communication_enabled IS DISTINCT FROM false
     OR NEW.financial_action_enabled IS DISTINCT FROM false THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'cos_production_authority_forbidden';
  END IF;
  IF NEW.enabled = true AND (
    NEW.execution_mode NOT IN ('shadow', 'supervised')
    OR NEW.kill_switch_engaged IS DISTINCT FROM false
    OR NEW.activated_by IS NULL
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
      MESSAGE = 'cos_activation_invalid';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cos_supervision_control_guard
  ON public.cos_supervision_controls;
CREATE TRIGGER trg_cos_supervision_control_guard
  BEFORE INSERT OR UPDATE ON public.cos_supervision_controls
  FOR EACH ROW EXECUTE FUNCTION public.cos_control_guard();

ALTER TABLE public.cos_supervision_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.department_report_contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.department_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cos_coordination_cycles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cos_coordination_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cos_supervised_events ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'cos_supervision_controls',
    'department_report_contracts',
    'department_reports',
    'cos_coordination_cycles',
    'cos_coordination_records',
    'cos_supervised_events'
  ] LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON public.%I',
      'tenant_iso_' || table_name, table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated ' ||
      'USING (' ||
        'tenant_id = NULLIF(auth.jwt()->''app_metadata''->>''tenant_id'', '''')::uuid ' ||
        'AND auth.jwt()->''app_metadata''->>''role'' IN (' ||
          '''owner'', ''platform_owner'', ''founder'', ''admin'', ' ||
          '''client_owner'', ''tenant_owner'', ''manager''' ||
        ')' ||
      ')',
      'tenant_iso_' || table_name, table_name
    );
  END LOOP;
END $$;

GRANT SELECT ON
  public.cos_supervision_controls,
  public.department_report_contracts,
  public.department_reports,
  public.cos_coordination_cycles,
  public.cos_coordination_records,
  public.cos_supervised_events
TO authenticated, service_role;
REVOKE INSERT, UPDATE, DELETE ON
  public.cos_supervision_controls,
  public.department_report_contracts,
  public.department_reports,
  public.cos_coordination_cycles,
  public.cos_coordination_records,
  public.cos_supervised_events
FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.cos_assert_service_and_control(
  p_tenant_id uuid,
  p_feature_gate_enabled boolean
) RETURNS public.cos_supervision_controls
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_claims text;
  v_calling_role text;
  v_control public.cos_supervision_controls%ROWTYPE;
BEGIN
  v_claims := NULLIF(current_setting('request.jwt.claims', true), '');
  v_calling_role := COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    CASE WHEN v_claims IS NOT NULL THEN v_claims::jsonb ->> 'role' END,
    session_user::text
  );
  IF v_calling_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501', MESSAGE = 'cos_requires_service_role';
  END IF;
  IF p_feature_gate_enabled IS DISTINCT FROM true THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501', MESSAGE = 'cos_writes_disabled';
  END IF;
  SELECT control.* INTO v_control
    FROM public.cos_supervision_controls control
   WHERE control.tenant_id = p_tenant_id;
  IF NOT FOUND
     OR v_control.enabled IS DISTINCT FROM true
     OR v_control.execution_mode NOT IN ('shadow', 'supervised')
     OR v_control.read_only IS DISTINCT FROM true
     OR v_control.kill_switch_engaged IS DISTINCT FROM false THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501', MESSAGE = 'cos_kill_switch_engaged';
  END IF;
  IF v_control.production_write_enabled IS DISTINCT FROM false
     OR v_control.provider_dispatch_enabled IS DISTINCT FROM false
     OR v_control.customer_communication_enabled IS DISTINCT FROM false
     OR v_control.financial_action_enabled IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'cos_production_authority_forbidden';
  END IF;
  RETURN v_control;
END;
$$;

CREATE OR REPLACE FUNCTION public.cos_report_command_rpc(
  p_tenant_id uuid,
  p_command text,
  p_department text,
  p_contract_id uuid,
  p_contract_version integer,
  p_schema_digest text,
  p_report_id uuid,
  p_source_department_report_id uuid,
  p_reporting_period_start date,
  p_reporting_period_end date,
  p_report_digest text,
  p_outcome_health text,
  p_structured_summary jsonb,
  p_expected_revision bigint,
  p_idempotency_key text,
  p_request_fingerprint text,
  p_actor_type text,
  p_actor_id text,
  p_authority_tier text,
  p_evidence jsonb,
  p_feature_gate_enabled boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_contract public.department_report_contracts%ROWTYPE;
  v_report public.department_reports%ROWTYPE;
  v_existing public.cos_supervised_events%ROWTYPE;
  v_event public.cos_supervised_events%ROWTYPE;
  v_entity_id uuid;
  v_entity_type text;
  v_previous text;
  v_resulting text;
  v_resulting_revision bigint;
  v_actor_uuid uuid;
  v_evidence_digest text;
  v_semantic text;
  v_observed_at timestamptz;
BEGIN
  PERFORM public.cos_assert_service_and_control(
    p_tenant_id, p_feature_gate_enabled
  );
  IF COALESCE(p_command, '') NOT IN (
    'register_contract', 'accept_contract',
    'submit_report', 'accept_report'
  ) OR COALESCE(p_department, '') NOT IN (
    'reliability_security_agent_ops', 'revenue_sales',
    'onboarding_implementation', 'client_success_support',
    'finance_data_governance', 'marketing_brand', 'product_engineering'
  ) OR p_expected_revision IS NULL OR p_expected_revision < 0
     OR COALESCE(p_request_fingerprint, '') !~ '^[a-f0-9]{64}$'
     OR char_length(btrim(COALESCE(p_idempotency_key, '')))
        NOT BETWEEN 8 AND 200 THEN
    RAISE EXCEPTION 'cos_report_command_invalid';
  END IF;
  IF p_actor_type = 'human' THEN
    BEGIN v_actor_uuid := p_actor_id::uuid;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'cos_human_actor_invalid';
    END;
    IF NOT EXISTS (
      SELECT 1 FROM public.tenant_users tenant_user
       WHERE tenant_user.tenant_id = p_tenant_id
         AND tenant_user.user_id = v_actor_uuid
    ) THEN
      RAISE EXCEPTION 'cos_human_actor_tenant_mismatch';
    END IF;
    IF (
      p_authority_tier = 'owner'
      AND NOT EXISTS (
        SELECT 1 FROM public.tenant_users tenant_user
         WHERE tenant_user.tenant_id = p_tenant_id
           AND tenant_user.user_id = v_actor_uuid
           AND tenant_user.role IN (
             'owner', 'platform_owner', 'founder', 'admin',
             'client_owner', 'tenant_owner'
           )
      )
    ) OR (
      p_authority_tier = 'department_head'
      AND NOT EXISTS (
        SELECT 1 FROM public.tenant_users tenant_user
         WHERE tenant_user.tenant_id = p_tenant_id
           AND tenant_user.user_id = v_actor_uuid
           AND tenant_user.role IN (
             'owner', 'platform_owner', 'founder', 'admin',
             'client_owner', 'tenant_owner', 'manager'
           )
      )
    ) THEN
      RAISE EXCEPTION 'cos_human_actor_role_mismatch';
    END IF;
  ELSIF p_actor_type IN ('service', 'agent') THEN
    IF char_length(btrim(COALESCE(p_actor_id, ''))) NOT BETWEEN 2 AND 160
       OR p_authority_tier = 'owner' THEN
      RAISE EXCEPTION 'cos_service_actor_invalid';
    END IF;
  ELSE
    RAISE EXCEPTION 'cos_actor_invalid';
  END IF;
  IF p_authority_tier NOT IN ('department_head', 'owner')
     OR jsonb_typeof(COALESCE(p_evidence, 'null'::jsonb)) <> 'object'
     OR p_evidence = '{}'::jsonb
     OR char_length(btrim(COALESCE(p_evidence->>'source_type', '')))
        NOT BETWEEN 3 AND 80
     OR char_length(btrim(COALESCE(p_evidence->>'source_id', '')))
        NOT BETWEEN 3 AND 240
     OR NULLIF(btrim(COALESCE(p_evidence->>'observed_at', '')), '') IS NULL
     OR (
       p_evidence::text
       || COALESCE(p_structured_summary, '{}'::jsonb)::text
     ) ~* (
       '"(send|dispatch|publish|charge|refund|transfer|production_write|'
       'provider_payload|provider_token|customer_email|customer_phone)"'
       '[[:space:]]*:'
     ) THEN
    RAISE EXCEPTION 'cos_evidence_or_authority_invalid';
  END IF;
  BEGIN
    v_observed_at := (p_evidence->>'observed_at')::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'cos_evidence_time_invalid';
  END;
  IF v_observed_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'cos_evidence_from_future';
  END IF;
  IF p_command IN ('accept_contract', 'accept_report')
     AND (p_actor_type <> 'human' OR p_authority_tier <> 'owner') THEN
    RAISE EXCEPTION 'cos_report_acceptance_requires_tenant_owner';
  END IF;
  v_evidence_digest := encode(
    digest(convert_to(p_evidence::text, 'UTF8'), 'sha256'), 'hex'
  );
  v_semantic := encode(digest(convert_to(jsonb_build_object(
    'tenant', p_tenant_id, 'command', p_command, 'department', p_department,
    'contract', p_contract_id, 'version', p_contract_version,
    'schema', p_schema_digest, 'report', p_report_id,
    'source_department_report', p_source_department_report_id,
    'start', p_reporting_period_start, 'end', p_reporting_period_end,
    'report_digest', p_report_digest, 'health', p_outcome_health,
    'summary', p_structured_summary, 'revision', p_expected_revision,
    'actor_type', p_actor_type, 'actor_id', p_actor_id,
    'authority', p_authority_tier, 'evidence', v_evidence_digest
  )::text, 'UTF8'), 'sha256'), 'hex');
  SELECT event.* INTO v_existing FROM public.cos_supervised_events event
   WHERE event.tenant_id = p_tenant_id
     AND event.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.request_fingerprint IS DISTINCT FROM p_request_fingerprint
       OR v_existing.semantic_fingerprint IS DISTINCT FROM v_semantic THEN
      RAISE EXCEPTION USING
        ERRCODE = '23505', MESSAGE = 'cos_idempotency_conflict';
    END IF;
    RETURN jsonb_build_object('outcome', 'replay', 'event', to_jsonb(v_existing));
  END IF;

  IF p_command = 'register_contract' THEN
    IF p_expected_revision <> 0 OR p_contract_id IS NULL
       OR p_contract_version IS NULL OR p_contract_version < 1
       OR p_schema_digest !~ '^[a-f0-9]{64}$' THEN
      RAISE EXCEPTION 'cos_contract_registration_invalid';
    END IF;
    INSERT INTO public.department_report_contracts (
      id, tenant_id, department, contract_version, schema_digest
    ) VALUES (
      p_contract_id, p_tenant_id, p_department,
      p_contract_version, p_schema_digest
    ) RETURNING * INTO v_contract;
    v_entity_id := v_contract.id;
    v_entity_type := 'report_contract';
    v_previous := NULL;
    v_resulting := 'draft';
    v_resulting_revision := 1;
  ELSIF p_command = 'accept_contract' THEN
    SELECT contract.* INTO v_contract
      FROM public.department_report_contracts contract
     WHERE contract.id = p_contract_id
       AND contract.tenant_id = p_tenant_id
       AND contract.department = p_department
       AND contract.contract_version = p_contract_version
       AND contract.schema_digest = p_schema_digest
     FOR UPDATE;
    IF NOT FOUND OR v_contract.acceptance_state <> 'draft'
       OR v_contract.revision <> p_expected_revision THEN
      RAISE EXCEPTION 'cos_contract_acceptance_gate_failed';
    END IF;
    UPDATE public.department_report_contracts
       SET acceptance_state = 'accepted', accepted_by = v_actor_uuid,
           accepted_at = now(), acceptance_evidence_digest = v_evidence_digest,
           revision = revision + 1, updated_at = now()
     WHERE id = p_contract_id AND tenant_id = p_tenant_id
    RETURNING * INTO v_contract;
    v_entity_id := v_contract.id;
    v_entity_type := 'report_contract';
    v_previous := 'draft';
    v_resulting := 'accepted';
    v_resulting_revision := v_contract.revision;
  ELSIF p_command = 'submit_report' THEN
    SELECT contract.* INTO v_contract
      FROM public.department_report_contracts contract
     WHERE contract.id = p_contract_id
       AND contract.tenant_id = p_tenant_id
       AND contract.department = p_department
       AND contract.contract_version = p_contract_version
       AND contract.schema_digest = p_schema_digest
       AND contract.acceptance_state = 'accepted';
    IF NOT FOUND OR p_expected_revision <> 0 OR p_report_id IS NULL
       OR p_source_department_report_id IS NULL
       OR p_reporting_period_start IS NULL OR p_reporting_period_end IS NULL
       OR p_reporting_period_end < p_reporting_period_start
       OR p_report_digest !~ '^[a-f0-9]{64}$'
       OR p_outcome_health NOT IN (
         'healthy', 'at_risk', 'unhealthy', 'unknown'
       )
       OR jsonb_typeof(COALESCE(p_structured_summary, 'null'::jsonb))
          <> 'object' THEN
      RAISE EXCEPTION 'cos_report_submission_gate_failed';
    END IF;
    IF p_department = 'reliability_security_agent_ops' AND NOT EXISTS (
      SELECT 1
        FROM public.reliability_head_reports source_report
       WHERE source_report.id = p_source_department_report_id
         AND source_report.tenant_id = p_tenant_id
         AND source_report.period_start::date = p_reporting_period_start
         AND source_report.period_end::date = p_reporting_period_end
         AND source_report.evidence_digest = p_report_digest
    ) THEN
      RAISE EXCEPTION 'cos_reliability_source_report_invalid';
    ELSIF p_department = 'revenue_sales' AND NOT EXISTS (
      SELECT 1
        FROM public.revenue_head_reports source_report
       WHERE source_report.id = p_source_department_report_id
         AND source_report.tenant_id = p_tenant_id
         AND source_report.period_start = p_reporting_period_start
         AND source_report.period_end = p_reporting_period_end
         AND source_report.evidence_digest = p_report_digest
    ) THEN
      RAISE EXCEPTION 'cos_revenue_source_report_invalid';
    END IF;
    INSERT INTO public.department_reports (
      id, tenant_id, department_report_contract_id,
      source_reliability_report_id, source_revenue_report_id, department,
      reporting_period_start, reporting_period_end, report_digest,
      outcome_health, structured_summary
    ) VALUES (
      p_report_id, p_tenant_id, p_contract_id,
      CASE WHEN p_department = 'reliability_security_agent_ops'
        THEN p_source_department_report_id ELSE NULL END,
      CASE WHEN p_department = 'revenue_sales'
        THEN p_source_department_report_id ELSE NULL END,
      p_department,
      p_reporting_period_start, p_reporting_period_end, p_report_digest,
      p_outcome_health, p_structured_summary
    ) RETURNING * INTO v_report;
    v_entity_id := v_report.id;
    v_entity_type := 'department_report';
    v_previous := NULL;
    v_resulting := 'submitted';
    v_resulting_revision := 1;
  ELSE
    SELECT report.* INTO v_report
      FROM public.department_reports report
      JOIN public.department_report_contracts contract
        ON contract.id = report.department_report_contract_id
       AND contract.tenant_id = report.tenant_id
     WHERE report.id = p_report_id
       AND report.tenant_id = p_tenant_id
       AND report.department = p_department
       AND report.reporting_period_start = p_reporting_period_start
       AND report.reporting_period_end = p_reporting_period_end
       AND report.report_digest = p_report_digest
       AND (
         (
           p_department = 'reliability_security_agent_ops'
           AND report.source_reliability_report_id =
             p_source_department_report_id
         )
         OR
         (
           p_department = 'revenue_sales'
           AND report.source_revenue_report_id =
             p_source_department_report_id
         )
         OR
         p_department NOT IN (
           'reliability_security_agent_ops', 'revenue_sales'
         )
       )
       AND contract.id = p_contract_id
       AND contract.contract_version = p_contract_version
       AND contract.schema_digest = p_schema_digest
       AND contract.acceptance_state = 'accepted'
     FOR UPDATE OF report;
    IF NOT FOUND OR v_report.report_state <> 'submitted'
       OR v_report.revision <> p_expected_revision THEN
      RAISE EXCEPTION 'cos_report_acceptance_gate_failed';
    END IF;
    UPDATE public.department_reports
       SET report_state = 'accepted', accepted_by = v_actor_uuid,
           accepted_at = now(), acceptance_evidence_digest = v_evidence_digest,
           revision = revision + 1, updated_at = now()
     WHERE id = p_report_id AND tenant_id = p_tenant_id
    RETURNING * INTO v_report;
    v_entity_id := v_report.id;
    v_entity_type := 'department_report';
    v_previous := 'submitted';
    v_resulting := 'accepted';
    v_resulting_revision := v_report.revision;
  END IF;

  INSERT INTO public.cos_supervised_events (
    tenant_id, entity_type, entity_id, command, previous_state,
    resulting_state, expected_revision, resulting_revision,
    actor_type, actor_id, authority_tier, evidence, evidence_digest,
    request_fingerprint, semantic_fingerprint, idempotency_key
  ) VALUES (
    p_tenant_id, v_entity_type, v_entity_id, p_command, v_previous,
    v_resulting, p_expected_revision, v_resulting_revision,
    p_actor_type, p_actor_id, p_authority_tier, p_evidence, v_evidence_digest,
    p_request_fingerprint, v_semantic, p_idempotency_key
  ) RETURNING * INTO v_event;
  RETURN jsonb_build_object(
    'outcome', 'applied', 'entity_type', v_entity_type,
    'entity_id', v_entity_id, 'state', v_resulting,
    'revision', v_resulting_revision, 'event_id', v_event.id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.chief_of_staff_command_rpc(
  p_tenant_id uuid,
  p_cycle_id uuid,
  p_command text,
  p_record_id uuid,
  p_record_type text,
  p_title text,
  p_department text,
  p_owner_type text,
  p_owner_id text,
  p_source_goal_id uuid,
  p_target_goal_id uuid,
  p_due_at timestamptz,
  p_record_payload jsonb,
  p_reporting_period_start date,
  p_reporting_period_end date,
  p_reliability_report_id uuid,
  p_revenue_report_id uuid,
  p_expected_revision bigint,
  p_idempotency_key text,
  p_request_fingerprint text,
  p_actor_type text,
  p_actor_id text,
  p_authority_tier text,
  p_evidence jsonb,
  p_feature_gate_enabled boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_cycle public.cos_coordination_cycles%ROWTYPE;
  v_record public.cos_coordination_records%ROWTYPE;
  v_existing public.cos_supervised_events%ROWTYPE;
  v_event public.cos_supervised_events%ROWTYPE;
  v_previous text;
  v_resulting text;
  v_actor_uuid uuid;
  v_owner_uuid uuid;
  v_evidence_digest text;
  v_semantic text;
  v_observed_at timestamptz;
BEGIN
  PERFORM public.cos_assert_service_and_control(
    p_tenant_id, p_feature_gate_enabled
  );
  IF COALESCE(p_command, '') NOT IN (
    'open_cycle', 'create_record', 'accept_follow_through',
    'escalate_follow_through', 'complete_follow_through', 'close_cycle'
  ) OR p_expected_revision IS NULL OR p_expected_revision < 0
     OR COALESCE(p_request_fingerprint, '') !~ '^[a-f0-9]{64}$'
     OR char_length(btrim(COALESCE(p_idempotency_key, '')))
        NOT BETWEEN 8 AND 200
     OR p_actor_type NOT IN ('human', 'service', 'agent')
     OR p_authority_tier NOT IN (
       'department_head', 'chief_of_staff', 'owner'
     ) THEN
    RAISE EXCEPTION 'cos_coordination_command_invalid';
  END IF;
  IF p_actor_type = 'human' THEN
    BEGIN v_actor_uuid := p_actor_id::uuid;
    EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'cos_human_actor_invalid';
    END;
    IF NOT EXISTS (
      SELECT 1 FROM public.tenant_users tenant_user
       WHERE tenant_user.tenant_id = p_tenant_id
         AND tenant_user.user_id = v_actor_uuid
    ) THEN
      RAISE EXCEPTION 'cos_human_actor_tenant_mismatch';
    END IF;
    IF (
      p_authority_tier IN ('owner', 'chief_of_staff')
      AND NOT EXISTS (
        SELECT 1 FROM public.tenant_users tenant_user
         WHERE tenant_user.tenant_id = p_tenant_id
           AND tenant_user.user_id = v_actor_uuid
           AND tenant_user.role IN (
             'owner', 'platform_owner', 'founder', 'admin',
             'client_owner', 'tenant_owner'
           )
      )
    ) OR (
      p_authority_tier = 'department_head'
      AND NOT EXISTS (
        SELECT 1 FROM public.tenant_users tenant_user
         WHERE tenant_user.tenant_id = p_tenant_id
           AND tenant_user.user_id = v_actor_uuid
           AND tenant_user.role IN (
             'owner', 'platform_owner', 'founder', 'admin',
             'client_owner', 'tenant_owner', 'manager'
           )
      )
    ) THEN
      RAISE EXCEPTION 'cos_human_actor_role_mismatch';
    END IF;
  ELSIF char_length(btrim(COALESCE(p_actor_id, ''))) NOT BETWEEN 2 AND 160
        OR p_authority_tier = 'owner' THEN
    RAISE EXCEPTION 'cos_service_actor_invalid';
  END IF;
  IF jsonb_typeof(COALESCE(p_evidence, 'null'::jsonb)) <> 'object'
     OR p_evidence = '{}'::jsonb
     OR char_length(btrim(COALESCE(p_evidence->>'source_type', '')))
        NOT BETWEEN 3 AND 80
     OR char_length(btrim(COALESCE(p_evidence->>'source_id', '')))
        NOT BETWEEN 3 AND 240
     OR NULLIF(btrim(COALESCE(p_evidence->>'observed_at', '')), '') IS NULL
     OR jsonb_typeof(COALESCE(p_record_payload, '{}'::jsonb)) <> 'object'
     OR (COALESCE(p_evidence, '{}'::jsonb)
         || COALESCE(p_record_payload, '{}'::jsonb))::text ~* (
       '"(send|dispatch|publish|charge|refund|transfer|production_write|'
       'provider_payload|provider_token|customer_email|customer_phone|'
       'execute_action|write_authority)"[[:space:]]*:'
     ) THEN
    RAISE EXCEPTION 'cos_production_bound_payload_forbidden';
  END IF;
  BEGIN
    v_observed_at := (p_evidence->>'observed_at')::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'cos_evidence_time_invalid';
  END;
  IF v_observed_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'cos_evidence_from_future';
  END IF;
  IF p_reporting_period_start IS NULL OR p_reporting_period_end IS NULL
     OR p_reporting_period_end < p_reporting_period_start
     OR p_reliability_report_id IS NULL OR p_revenue_report_id IS NULL THEN
    RAISE EXCEPTION 'cos_exact_reporting_gate_required';
  END IF;

  -- Stricter dependency gate: exact-window reports must both be accepted and
  -- each must reference an accepted contract for its required department.
  IF NOT EXISTS (
    SELECT 1
      FROM public.department_reports report
      JOIN public.department_report_contracts contract
        ON contract.id = report.department_report_contract_id
       AND contract.tenant_id = report.tenant_id
     WHERE report.id = p_reliability_report_id
       AND report.tenant_id = p_tenant_id
       AND report.department = 'reliability_security_agent_ops'
       AND report.reporting_period_start = p_reporting_period_start
       AND report.reporting_period_end = p_reporting_period_end
       AND report.report_state = 'accepted'
       AND contract.department = 'reliability_security_agent_ops'
       AND contract.acceptance_state = 'accepted'
  ) OR NOT EXISTS (
    SELECT 1
      FROM public.department_reports report
      JOIN public.department_report_contracts contract
        ON contract.id = report.department_report_contract_id
       AND contract.tenant_id = report.tenant_id
     WHERE report.id = p_revenue_report_id
       AND report.tenant_id = p_tenant_id
       AND report.department = 'revenue_sales'
       AND report.reporting_period_start = p_reporting_period_start
       AND report.reporting_period_end = p_reporting_period_end
       AND report.report_state = 'accepted'
       AND contract.department = 'revenue_sales'
       AND contract.acceptance_state = 'accepted'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'cos_reliability_revenue_report_gate_unmet';
  END IF;

  v_evidence_digest := encode(
    digest(convert_to(p_evidence::text, 'UTF8'), 'sha256'), 'hex'
  );
  v_semantic := encode(digest(convert_to(jsonb_build_object(
    'tenant', p_tenant_id, 'cycle', p_cycle_id, 'command', p_command,
    'record', p_record_id, 'type', p_record_type, 'title', p_title,
    'department', p_department, 'owner_type', p_owner_type,
    'owner_id', p_owner_id, 'source_goal', p_source_goal_id,
    'target_goal', p_target_goal_id, 'due', p_due_at,
    'payload', p_record_payload, 'start', p_reporting_period_start,
    'end', p_reporting_period_end, 'reliability', p_reliability_report_id,
    'revenue', p_revenue_report_id, 'revision', p_expected_revision,
    'actor_type', p_actor_type, 'actor_id', p_actor_id,
    'authority', p_authority_tier, 'evidence', v_evidence_digest
  )::text, 'UTF8'), 'sha256'), 'hex');
  SELECT event.* INTO v_existing FROM public.cos_supervised_events event
   WHERE event.tenant_id = p_tenant_id
     AND event.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.request_fingerprint IS DISTINCT FROM p_request_fingerprint
       OR v_existing.semantic_fingerprint IS DISTINCT FROM v_semantic THEN
      RAISE EXCEPTION USING
        ERRCODE = '23505', MESSAGE = 'cos_idempotency_conflict';
    END IF;
    RETURN jsonb_build_object('outcome', 'replay', 'event', to_jsonb(v_existing));
  END IF;

  IF p_command = 'open_cycle' THEN
    IF p_expected_revision <> 0 OR p_cycle_id IS NULL THEN
      RAISE EXCEPTION 'cos_cycle_open_invalid';
    END IF;
    INSERT INTO public.cos_coordination_cycles (
      id, tenant_id, reporting_period_start, reporting_period_end,
      reliability_report_id, revenue_report_id
    ) VALUES (
      p_cycle_id, p_tenant_id, p_reporting_period_start, p_reporting_period_end,
      p_reliability_report_id, p_revenue_report_id
    ) RETURNING * INTO v_cycle;
    v_previous := NULL;
    v_resulting := 'supervised_open';
  ELSE
    SELECT cycle.* INTO v_cycle FROM public.cos_coordination_cycles cycle
     WHERE cycle.id = p_cycle_id
       AND cycle.tenant_id = p_tenant_id
       AND cycle.reporting_period_start = p_reporting_period_start
       AND cycle.reporting_period_end = p_reporting_period_end
       AND cycle.reliability_report_id = p_reliability_report_id
       AND cycle.revenue_report_id = p_revenue_report_id
     FOR UPDATE;
    IF NOT FOUND OR v_cycle.coordination_state <> 'supervised_open'
       OR v_cycle.revision <> p_expected_revision THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001', MESSAGE = 'cos_cycle_revision_or_identity_conflict';
    END IF;
    v_previous := v_cycle.coordination_state;
    IF p_command = 'create_record' THEN
      IF p_record_id IS NULL OR p_record_type NOT IN (
        'company_goal', 'dependency', 'capacity_conflict',
        'decision_required', 'exception', 'follow_through'
      ) OR char_length(btrim(COALESCE(p_title, ''))) NOT BETWEEN 3 AND 240
         OR p_owner_type NOT IN ('human', 'agent', 'service')
         OR char_length(btrim(COALESCE(p_owner_id, ''))) NOT BETWEEN 2 AND 160
         OR (p_record_type = 'company_goal'
             AND jsonb_typeof(p_record_payload->'kpis') <> 'array')
         OR (p_record_type = 'dependency' AND (
           p_source_goal_id IS NULL OR p_target_goal_id IS NULL
           OR p_source_goal_id = p_target_goal_id
           OR NOT EXISTS (
             SELECT 1 FROM public.cos_coordination_records goal
              WHERE goal.id = p_source_goal_id
                AND goal.tenant_id = p_tenant_id
                AND goal.cos_coordination_cycle_id = p_cycle_id
                AND goal.record_type = 'company_goal'
           )
           OR NOT EXISTS (
             SELECT 1 FROM public.cos_coordination_records goal
              WHERE goal.id = p_target_goal_id
                AND goal.tenant_id = p_tenant_id
                AND goal.cos_coordination_cycle_id = p_cycle_id
                AND goal.record_type = 'company_goal'
           )
         ))
         OR (p_record_type <> 'dependency'
             AND (p_source_goal_id IS NOT NULL OR p_target_goal_id IS NOT NULL))
         OR (p_record_type = 'follow_through' AND p_due_at IS NULL) THEN
        RAISE EXCEPTION 'cos_record_contract_invalid';
      END IF;
      IF p_owner_type = 'human' THEN
        BEGIN v_owner_uuid := p_owner_id::uuid;
        EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'cos_owner_invalid';
        END;
        IF NOT EXISTS (
          SELECT 1 FROM public.tenant_users tenant_user
           WHERE tenant_user.tenant_id = p_tenant_id
             AND tenant_user.user_id = v_owner_uuid
        ) THEN
          RAISE EXCEPTION 'cos_owner_tenant_mismatch';
        END IF;
      END IF;
      v_resulting := CASE p_record_type
        WHEN 'company_goal' THEN 'active'
        WHEN 'decision_required' THEN 'pending'
        WHEN 'follow_through' THEN 'assigned'
        ELSE 'open'
      END;
      INSERT INTO public.cos_coordination_records (
        id, tenant_id, cos_coordination_cycle_id, record_type, status,
        title, department, owner_type, owner_id, source_goal_id,
        target_goal_id, record_payload, due_at
      ) VALUES (
        p_record_id, p_tenant_id, p_cycle_id, p_record_type, v_resulting,
        p_title, p_department, p_owner_type, p_owner_id, p_source_goal_id,
        p_target_goal_id, p_record_payload, p_due_at
      ) RETURNING * INTO v_record;
    ELSIF p_command IN (
      'accept_follow_through', 'escalate_follow_through',
      'complete_follow_through'
    ) THEN
      SELECT record.* INTO v_record
        FROM public.cos_coordination_records record
       WHERE record.id = p_record_id
         AND record.tenant_id = p_tenant_id
         AND record.cos_coordination_cycle_id = p_cycle_id
         AND record.record_type = 'follow_through'
       FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'cos_follow_through_not_found'; END IF;
      IF p_command = 'accept_follow_through' THEN
        IF v_record.status <> 'assigned'
           OR p_actor_type IS DISTINCT FROM v_record.owner_type
           OR p_actor_id IS DISTINCT FROM v_record.owner_id THEN
          RAISE EXCEPTION 'cos_follow_through_acceptance_invalid';
        END IF;
        UPDATE public.cos_coordination_records
           SET status = 'accepted', accepted_at = now(),
               revision = revision + 1, updated_at = now()
         WHERE id = p_record_id AND tenant_id = p_tenant_id
        RETURNING * INTO v_record;
        v_resulting := 'accepted';
      ELSIF p_command = 'escalate_follow_through' THEN
        IF v_record.status NOT IN ('assigned', 'accepted')
           OR now() < v_record.due_at THEN
          RAISE EXCEPTION 'cos_follow_through_escalation_invalid';
        END IF;
        UPDATE public.cos_coordination_records
           SET status = 'escalated', escalated_at = now(),
               revision = revision + 1, updated_at = now()
         WHERE id = p_record_id AND tenant_id = p_tenant_id
        RETURNING * INTO v_record;
        v_resulting := 'escalated';
      ELSE
        IF v_record.status NOT IN ('accepted', 'escalated') THEN
          RAISE EXCEPTION 'cos_follow_through_completion_invalid';
        END IF;
        IF (
          p_actor_type IS DISTINCT FROM v_record.owner_type
          OR p_actor_id IS DISTINCT FROM v_record.owner_id
        ) AND NOT (
          p_actor_type = 'human' AND p_authority_tier = 'owner'
        ) THEN
          RAISE EXCEPTION 'cos_follow_through_completer_invalid';
        END IF;
        UPDATE public.cos_coordination_records
           SET status = 'completed', completed_at = now(),
               revision = revision + 1, updated_at = now()
         WHERE id = p_record_id AND tenant_id = p_tenant_id
        RETURNING * INTO v_record;
        v_resulting := 'completed';
      END IF;
    ELSE
      IF p_actor_type <> 'human' OR p_authority_tier <> 'owner' THEN
        RAISE EXCEPTION 'cos_cycle_close_requires_owner';
      END IF;
      UPDATE public.cos_coordination_cycles
         SET coordination_state = 'supervised_closed', closed_at = now(),
             revision = revision + 1, updated_at = now()
       WHERE id = p_cycle_id AND tenant_id = p_tenant_id
      RETURNING * INTO v_cycle;
      v_resulting := 'supervised_closed';
    END IF;
    IF p_command <> 'close_cycle' THEN
      UPDATE public.cos_coordination_cycles
         SET revision = revision + 1, updated_at = now()
       WHERE id = p_cycle_id AND tenant_id = p_tenant_id
      RETURNING * INTO v_cycle;
    END IF;
  END IF;

  INSERT INTO public.cos_supervised_events (
    tenant_id, entity_type, entity_id, command, previous_state,
    resulting_state, expected_revision, resulting_revision,
    actor_type, actor_id, authority_tier, evidence, evidence_digest,
    request_fingerprint, semantic_fingerprint, idempotency_key
  ) VALUES (
    p_tenant_id,
    CASE WHEN p_command IN ('open_cycle', 'close_cycle')
      THEN 'coordination_cycle' ELSE 'coordination_record' END,
    CASE WHEN p_command IN ('open_cycle', 'close_cycle')
      THEN p_cycle_id ELSE p_record_id END,
    p_command, v_previous, v_resulting, p_expected_revision, v_cycle.revision,
    p_actor_type, p_actor_id, p_authority_tier, p_evidence, v_evidence_digest,
    p_request_fingerprint, v_semantic, p_idempotency_key
  ) RETURNING * INTO v_event;
  RETURN jsonb_build_object(
    'outcome', 'applied', 'cycle_id', p_cycle_id,
    'cycle_revision', v_cycle.revision, 'state', v_resulting,
    'record_id', p_record_id, 'event_id', v_event.id,
    'execution_mode', 'supervised_read_only'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.cos_assert_service_and_control(uuid, boolean)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cos_report_command_rpc(
  uuid, text, text, uuid, integer, text, uuid, uuid, date, date, text, text,
  jsonb, bigint, text, text, text, text, text, jsonb, boolean
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cos_report_command_rpc(
  uuid, text, text, uuid, integer, text, uuid, uuid, date, date, text, text,
  jsonb, bigint, text, text, text, text, text, jsonb, boolean
) TO service_role;
REVOKE ALL ON FUNCTION public.chief_of_staff_command_rpc(
  uuid, uuid, text, uuid, text, text, text, text, text, uuid, uuid,
  timestamptz, jsonb, date, date, uuid, uuid, bigint, text, text,
  text, text, text, jsonb, boolean
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chief_of_staff_command_rpc(
  uuid, uuid, text, uuid, text, text, text, text, text, uuid, uuid,
  timestamptz, jsonb, date, date, uuid, uuid, bigint, text, text,
  text, text, text, jsonb, boolean
) TO service_role;

CREATE OR REPLACE FUNCTION public.cos_kill_switch_rpc(
  p_tenant_id uuid,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_reason_digest text;
  v_revision bigint;
  v_claims text;
  v_role text;
BEGIN
  v_claims := NULLIF(current_setting('request.jwt.claims', true), '');
  v_role := COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    CASE WHEN v_claims IS NOT NULL THEN v_claims::jsonb ->> 'role' END,
    session_user::text
  );
  IF v_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'cos_requires_service_role';
  END IF;
  IF p_tenant_id IS NULL
     OR char_length(btrim(COALESCE(p_reason, ''))) NOT BETWEEN 8 AND 240 THEN
    RAISE EXCEPTION 'cos_kill_switch_reason_required';
  END IF;
  v_reason_digest := encode(
    digest(convert_to(p_reason, 'UTF8'), 'sha256'), 'hex'
  );
  UPDATE public.cos_supervision_controls
     SET enabled = false, execution_mode = 'disabled',
         kill_switch_engaged = true, revision = revision + 1,
         activation_evidence =
           (activation_evidence - 'kill_switch_reason')
           || jsonb_build_object(
             'kill_switch_reason_digest', v_reason_digest,
             'kill_switch_engaged_at', now()
           ),
         updated_at = now()
   WHERE tenant_id = p_tenant_id
  RETURNING revision INTO v_revision;
  IF NOT FOUND THEN RAISE EXCEPTION 'cos_control_not_found'; END IF;
  RETURN jsonb_build_object(
    'outcome', 'contained', 'tenant_id', p_tenant_id,
    'revision', v_revision, 'reason_digest', v_reason_digest
  );
END;
$$;

REVOKE ALL ON FUNCTION public.cos_kill_switch_rpc(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cos_kill_switch_rpc(uuid, text)
  TO service_role;
