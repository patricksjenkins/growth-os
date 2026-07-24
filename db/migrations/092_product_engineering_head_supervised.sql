-- ============================================================================
-- Migration 092: Supervised Product and Engineering Department Head
-- Date: 2026-07-24
--
-- Additive evidence-only executive control over engineering quality, change
-- readiness, regression and isolation evidence, incident escape, accessibility,
-- security debt, and measured product outcomes. It cannot merge code, deploy,
-- apply migrations, activate features, release mobile builds, contact providers
-- or customers, change pricing/legal policy, or move money. Engineering work
-- completion remains distinct from a proven product outcome.
--
-- ROLLBACK: db/rollbacks/092_product_engineering_head_supervised_rollback.sql
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.product_engineering_head_controls (
  tenant_id                         uuid PRIMARY KEY
                                    REFERENCES public.tenants(id) ON DELETE CASCADE,
  department_code                   text NOT NULL DEFAULT 'product_engineering'
                                    CHECK (department_code = 'product_engineering'),
  registered_head_id                text NOT NULL CHECK (
                                      char_length(btrim(registered_head_id))
                                      BETWEEN 3 AND 160
                                    ),
  mission                           text NOT NULL CHECK (
                                      char_length(btrim(mission)) BETWEEN 40 AND 1000
                                    ),
  kpi_contract                      jsonb NOT NULL CHECK (
                                      jsonb_typeof(kpi_contract) = 'object'
                                      AND kpi_contract ?& ARRAY[
                                        'reliability_quality_pass_rate',
                                        'change_lead_time_hours',
                                        'change_throughput_rate',
                                        'regression_escape_rate',
                                        'tenant_isolation_gate_pass_rate',
                                        'incident_escape_rate',
                                        'rollback_readiness_rate',
                                        'accessibility_debt_count',
                                        'security_debt_count',
                                        'product_outcome_achievement_rate'
                                      ]
                                    ),
  accepted_report_types             text[] NOT NULL DEFAULT ARRAY[
                                      'reliability_quality',
                                      'change_throughput',
                                      'regression_isolation',
                                      'incident_rollback',
                                      'accessibility_security',
                                      'product_outcome'
                                    ]::text[] CHECK (
                                      accepted_report_types @> ARRAY[
                                        'reliability_quality',
                                        'change_throughput',
                                        'regression_isolation',
                                        'incident_rollback',
                                        'accessibility_security',
                                        'product_outcome'
                                      ]::text[]
                                    ),
  authority_contract                jsonb NOT NULL CHECK (
                                      jsonb_typeof(authority_contract) = 'object'
                                      AND authority_contract <> '{}'::jsonb
                                    ),
  enabled                           boolean NOT NULL DEFAULT false,
  execution_mode                    text NOT NULL DEFAULT 'disabled' CHECK (
                                      execution_mode IN (
                                        'disabled', 'shadow',
                                        'supervised_read_only'
                                      )
                                    ),
  kill_switch_engaged               boolean NOT NULL DEFAULT true,
  code_merge_authority              boolean NOT NULL DEFAULT false
                                    CHECK (code_merge_authority = false),
  deployment_authority              boolean NOT NULL DEFAULT false
                                    CHECK (deployment_authority = false),
  migration_apply_authority         boolean NOT NULL DEFAULT false
                                    CHECK (migration_apply_authority = false),
  feature_activation_authority      boolean NOT NULL DEFAULT false
                                    CHECK (feature_activation_authority = false),
  release_authority                 boolean NOT NULL DEFAULT false
                                    CHECK (release_authority = false),
  external_provider_authority       boolean NOT NULL DEFAULT false
                                    CHECK (external_provider_authority = false),
  customer_communication_authority  boolean NOT NULL DEFAULT false
                                    CHECK (customer_communication_authority = false),
  money_movement_authority          boolean NOT NULL DEFAULT false
                                    CHECK (money_movement_authority = false),
  pricing_authority                 boolean NOT NULL DEFAULT false
                                    CHECK (pricing_authority = false),
  legal_policy_authority            boolean NOT NULL DEFAULT false
                                    CHECK (legal_policy_authority = false),
  revision                          bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  activated_by                      uuid,
  activation_evidence               jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                        timestamptz NOT NULL DEFAULT now(),
  updated_at                        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.product_engineering_outcome_receipts (
  id                                uuid PRIMARY KEY,
  tenant_id                         uuid NOT NULL
                                    REFERENCES public.tenants(id) ON DELETE RESTRICT,
  product_tenant_id                 uuid NOT NULL
                                    REFERENCES public.tenants(id) ON DELETE RESTRICT,
  outcome_state                     text NOT NULL CHECK (
                                      outcome_state IN ('achieved', 'not_achieved')
                                    ),
  measurement_digest                text NOT NULL CHECK (
                                      measurement_digest ~ '^[a-f0-9]{64}$'
                                    ),
  observed_at                       timestamptz NOT NULL,
  verified_by_user_id               uuid NOT NULL,
  evidence                          jsonb NOT NULL CHECK (
                                      jsonb_typeof(evidence) = 'object'
                                      AND evidence <> '{}'::jsonb
                                      AND evidence ?& ARRAY[
                                        'source_type', 'source_id',
                                        'observed_at', 'measurement_digest'
                                      ]
                                      AND evidence - ARRAY[
                                        'source_type', 'source_id',
                                        'observed_at', 'measurement_digest'
                                      ] = '{}'::jsonb
                                    ),
  evidence_digest                   text NOT NULL CHECK (
                                      evidence_digest ~ '^[a-f0-9]{64}$'
                                    ),
  idempotency_key                   text NOT NULL CHECK (
                                      char_length(idempotency_key) BETWEEN 8 AND 200
                                    ),
  request_fingerprint               text NOT NULL CHECK (
                                      request_fingerprint ~ '^[a-f0-9]{64}$'
                                    ),
  semantic_fingerprint              text NOT NULL CHECK (
                                      semantic_fingerprint ~ '^[a-f0-9]{64}$'
                                    ),
  verified_at                       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id, product_tenant_id),
  UNIQUE (tenant_id, idempotency_key),
  CHECK (product_tenant_id = tenant_id),
  CHECK (observed_at <= verified_at + interval '5 minutes'),
  FOREIGN KEY (tenant_id, verified_by_user_id)
    REFERENCES public.tenant_users(tenant_id, user_id)
    ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS public.product_engineering_head_reports (
  id                                uuid PRIMARY KEY,
  tenant_id                         uuid NOT NULL
                                    REFERENCES public.tenants(id) ON DELETE RESTRICT,
  product_tenant_id                 uuid NOT NULL
                                    REFERENCES public.tenants(id) ON DELETE RESTRICT,
  source_evidence_id                uuid NOT NULL,
  source_run_id                     uuid,
  product_outcome_receipt_id        uuid,
  report_type                       text NOT NULL CHECK (
                                      report_type IN (
                                        'reliability_quality',
                                        'change_throughput',
                                        'regression_isolation',
                                        'incident_rollback',
                                        'accessibility_security',
                                        'product_outcome'
                                      )
                                    ),
  product_scope                     text NOT NULL CHECK (
                                      product_scope IN (
                                        'web', 'mobile', 'backend', 'data',
                                        'agents', 'platform', 'portfolio'
                                      )
                                    ),
  schema_version                    integer NOT NULL DEFAULT 1
                                    CHECK (schema_version = 1),
  period_start                      timestamptz NOT NULL,
  period_end                        timestamptz NOT NULL,
  execution_health_state            text NOT NULL CHECK (
                                      execution_health_state IN (
                                        'unknown', 'healthy', 'degraded', 'failed'
                                      )
                                    ),
  product_outcome_state            text NOT NULL DEFAULT 'unknown' CHECK (
                                      product_outcome_state IN (
                                        'unknown', 'unproven',
                                        'achieved', 'not_achieved'
                                      )
                                    ),
  outcome_verified                  boolean NOT NULL DEFAULT false,
  kpi_results                       jsonb NOT NULL CHECK (
                                      jsonb_typeof(kpi_results) = 'array'
                                      AND jsonb_array_length(kpi_results) > 0
                                    ),
  report_body                       jsonb NOT NULL CHECK (
                                      jsonb_typeof(report_body) = 'object'
                                      AND report_body <> '{}'::jsonb
                                    ),
  evidence                          jsonb NOT NULL CHECK (
                                      jsonb_typeof(evidence) = 'object'
                                      AND evidence <> '{}'::jsonb
                                    ),
  evidence_digest                   text NOT NULL
                                    CHECK (evidence_digest ~ '^[a-f0-9]{64}$'),
  evidence_observed_at              timestamptz NOT NULL,
  accepted_by_type                  text NOT NULL CHECK (
                                      accepted_by_type IN (
                                        'human', 'agent', 'service', 'system'
                                      )
                                    ),
  accepted_by_id                    text,
  accepted_authority_tier           text NOT NULL CHECK (
                                      accepted_authority_tier IN (
                                        'system', 'operator',
                                        'department_head', 'owner'
                                      )
                                    ),
  idempotency_key                   text NOT NULL CHECK (
                                      char_length(idempotency_key) BETWEEN 8 AND 200
                                    ),
  request_fingerprint               text NOT NULL
                                    CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  semantic_fingerprint              text NOT NULL
                                    CHECK (semantic_fingerprint ~ '^[a-f0-9]{64}$'),
  accepted_at                       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (id, tenant_id, product_tenant_id),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, report_type, source_evidence_id),
  FOREIGN KEY (product_outcome_receipt_id, tenant_id, product_tenant_id)
    REFERENCES public.product_engineering_outcome_receipts(
      id, tenant_id, product_tenant_id
    )
    ON DELETE RESTRICT,
  CHECK (product_tenant_id = tenant_id),
  CHECK (period_end > period_start),
  CHECK (
    (product_outcome_state IN ('unknown', 'unproven')
      AND outcome_verified = false)
    OR
    (report_type = 'product_outcome'
      AND product_outcome_state IN ('achieved', 'not_achieved')
      AND outcome_verified = true)
  ),
  CHECK (
    (report_type = 'product_outcome'
      AND product_outcome_receipt_id IS NOT NULL
      AND source_evidence_id = product_outcome_receipt_id)
    OR
    (report_type <> 'product_outcome'
      AND product_outcome_receipt_id IS NULL)
  ),
  CHECK (evidence_observed_at <= accepted_at + interval '5 minutes')
);

CREATE TABLE IF NOT EXISTS public.product_engineering_head_cases (
  id                                uuid PRIMARY KEY,
  tenant_id                         uuid NOT NULL
                                    REFERENCES public.tenants(id) ON DELETE RESTRICT,
  product_tenant_id                  uuid NOT NULL
                                    REFERENCES public.tenants(id) ON DELETE RESTRICT,
  source_report_id                  uuid NOT NULL,
  case_type                         text NOT NULL CHECK (
                                      case_type IN (
                                        'goal', 'work', 'decision', 'exception'
                                      )
                                    ),
  title                             text NOT NULL CHECK (
                                      char_length(btrim(title)) BETWEEN 3 AND 240
                                    ),
  contract                          jsonb NOT NULL CHECK (
                                      jsonb_typeof(contract) = 'object'
                                      AND contract <> '{}'::jsonb
                                    ),
  lifecycle_state                   text NOT NULL CHECK (
                                      lifecycle_state IN (
                                        'active', 'assigned', 'accepted',
                                        'escalated', 'completed', 'recommended',
                                        'approved', 'rejected', 'open', 'resolved'
                                      )
                                    ),
  product_outcome_state            text NOT NULL DEFAULT 'unknown' CHECK (
                                      product_outcome_state IN (
                                        'unknown', 'unproven',
                                        'achieved', 'not_achieved',
                                        'not_applicable'
                                      )
                                    ),
  revision                          bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  owner_id                          uuid NOT NULL,
  assignee_id                       uuid,
  assigned_at                       timestamptz,
  accepted_at                       timestamptz,
  sla_due_at                        timestamptz NOT NULL,
  escalated_at                      timestamptz,
  escalation_code                   text CHECK (
                                      escalation_code IS NULL
                                      OR escalation_code ~ '^[a-z][a-z0-9_]{2,79}$'
                                    ),
  completed_at                      timestamptz,
  completion_evidence_digest        text CHECK (
                                      completion_evidence_digest IS NULL
                                      OR completion_evidence_digest ~ '^[a-f0-9]{64}$'
                                    ),
  outcome_evidence_digest           text CHECK (
                                      outcome_evidence_digest IS NULL
                                      OR outcome_evidence_digest ~ '^[a-f0-9]{64}$'
                                    ),
  outcome_observed_at               timestamptz,
  product_outcome_receipt_id        uuid,
  product_outcome_verified         boolean GENERATED ALWAYS AS (
                                      product_outcome_state IN (
                                        'achieved', 'not_achieved'
                                      )
                                      AND outcome_evidence_digest IS NOT NULL
                                      AND outcome_observed_at IS NOT NULL
                                    ) STORED,
  last_action_at                    timestamptz NOT NULL,
  created_at                        timestamptz NOT NULL DEFAULT now(),
  updated_at                        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (id, tenant_id, product_tenant_id),
  FOREIGN KEY (source_report_id, tenant_id, product_tenant_id)
    REFERENCES public.product_engineering_head_reports(id, tenant_id, product_tenant_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (product_outcome_receipt_id, tenant_id, product_tenant_id)
    REFERENCES public.product_engineering_outcome_receipts(
      id, tenant_id, product_tenant_id
    )
    ON DELETE RESTRICT,
  CHECK (
    (case_type = 'goal' AND lifecycle_state IN ('active', 'completed'))
    OR
    (case_type = 'work' AND lifecycle_state IN (
      'assigned', 'accepted', 'escalated', 'completed'
    ))
    OR
    (case_type = 'decision' AND lifecycle_state IN (
      'recommended', 'approved', 'rejected'
    ))
    OR
    (case_type = 'exception' AND lifecycle_state IN (
      'open', 'escalated', 'resolved'
    ))
  ),
  CHECK (case_type = 'work' OR assignee_id IS NULL),
  CHECK (
    case_type <> 'work'
    OR (assignee_id IS NOT NULL AND assigned_at IS NOT NULL)
  ),
  CHECK (
    lifecycle_state NOT IN ('completed', 'resolved', 'approved', 'rejected')
    OR (completed_at IS NOT NULL AND completion_evidence_digest IS NOT NULL)
  ),
  CHECK (
    product_outcome_state NOT IN ('achieved', 'not_achieved')
    OR (
      outcome_evidence_digest IS NOT NULL
      AND outcome_observed_at IS NOT NULL
      AND product_outcome_receipt_id IS NOT NULL
    )
  )
);

CREATE TABLE IF NOT EXISTS public.product_engineering_head_events (
  id                                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                         uuid NOT NULL,
  product_tenant_id                  uuid NOT NULL,
  case_id                           uuid NOT NULL,
  case_type                         text NOT NULL,
  action                            text NOT NULL CHECK (
                                      action IN (
                                        'create_goal', 'complete_goal',
                                        'create_work', 'accept_work',
                                        'escalate_work', 'complete_work',
                                        'record_product_outcome',
                                        'recommend_decision',
                                        'decide_recommendation',
                                        'raise_exception', 'resolve_exception'
                                      )
                                    ),
  previous_state                    text NOT NULL,
  next_state                        text NOT NULL,
  previous_product_outcome         text NOT NULL,
  next_product_outcome             text NOT NULL,
  expected_revision                 bigint NOT NULL CHECK (expected_revision >= 0),
  resulting_revision                bigint NOT NULL CHECK (resulting_revision > 0),
  actor_type                        text NOT NULL CHECK (
                                      actor_type IN (
                                        'human', 'agent', 'service', 'system'
                                      )
                                    ),
  actor_id                          text,
  authority_tier                    text NOT NULL CHECK (
                                      authority_tier IN (
                                        'system', 'operator',
                                        'department_head', 'owner'
                                      )
                                    ),
  evidence                          jsonb NOT NULL CHECK (
                                      jsonb_typeof(evidence) = 'object'
                                      AND evidence <> '{}'::jsonb
                                    ),
  evidence_digest                   text NOT NULL
                                    CHECK (evidence_digest ~ '^[a-f0-9]{64}$'),
  request_fingerprint               text NOT NULL
                                    CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  semantic_fingerprint              text NOT NULL
                                    CHECK (semantic_fingerprint ~ '^[a-f0-9]{64}$'),
  idempotency_key                   text NOT NULL CHECK (
                                      char_length(idempotency_key) BETWEEN 8 AND 200
                                    ),
  created_at                        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (case_id, tenant_id, product_tenant_id)
    REFERENCES public.product_engineering_head_cases(id, tenant_id, product_tenant_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_product_engineering_head_reports_period
  ON public.product_engineering_head_reports
    (tenant_id, report_type, product_scope, period_end DESC);
CREATE INDEX IF NOT EXISTS idx_product_engineering_outcome_receipts_observed
  ON public.product_engineering_outcome_receipts
    (tenant_id, product_tenant_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_product_engineering_head_cases_due
  ON public.product_engineering_head_cases
    (tenant_id, product_tenant_id, case_type, lifecycle_state, sla_due_at);
CREATE INDEX IF NOT EXISTS idx_product_engineering_head_events_history
  ON public.product_engineering_head_events
    (tenant_id, product_tenant_id, case_id, created_at, id);

CREATE OR REPLACE FUNCTION public.product_engineering_head_immutable_evidence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'product_engineering_head_evidence_is_immutable';
END;
$$;

DROP TRIGGER IF EXISTS trg_product_engineering_head_reports_immutable
  ON public.product_engineering_head_reports;
CREATE TRIGGER trg_product_engineering_head_reports_immutable
  BEFORE UPDATE OR DELETE ON public.product_engineering_head_reports
  FOR EACH ROW EXECUTE FUNCTION public.product_engineering_head_immutable_evidence();

DROP TRIGGER IF EXISTS trg_product_engineering_outcome_receipts_immutable
  ON public.product_engineering_outcome_receipts;
CREATE TRIGGER trg_product_engineering_outcome_receipts_immutable
  BEFORE UPDATE OR DELETE ON public.product_engineering_outcome_receipts
  FOR EACH ROW EXECUTE FUNCTION public.product_engineering_head_immutable_evidence();

DROP TRIGGER IF EXISTS trg_product_engineering_head_events_immutable
  ON public.product_engineering_head_events;
CREATE TRIGGER trg_product_engineering_head_events_immutable
  BEFORE UPDATE OR DELETE ON public.product_engineering_head_events
  FOR EACH ROW EXECUTE FUNCTION public.product_engineering_head_immutable_evidence();

CREATE OR REPLACE FUNCTION public.product_engineering_head_case_identity_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.tenant_users tenant_user
     WHERE tenant_user.tenant_id = NEW.tenant_id
       AND tenant_user.user_id = NEW.owner_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'product_engineering_head_owner_tenant_mismatch';
  END IF;
  IF NEW.assignee_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.tenant_users tenant_user
     WHERE tenant_user.tenant_id = NEW.tenant_id
       AND tenant_user.user_id = NEW.assignee_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'product_engineering_head_assignee_tenant_mismatch';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_product_engineering_head_case_identity_guard
  ON public.product_engineering_head_cases;
CREATE TRIGGER trg_product_engineering_head_case_identity_guard
  BEFORE INSERT OR UPDATE ON public.product_engineering_head_cases
  FOR EACH ROW EXECUTE FUNCTION public.product_engineering_head_case_identity_guard();

CREATE OR REPLACE FUNCTION public.product_engineering_head_control_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.code_merge_authority
     OR NEW.deployment_authority
     OR NEW.migration_apply_authority
     OR NEW.feature_activation_authority
     OR NEW.release_authority
     OR NEW.external_provider_authority
     OR NEW.customer_communication_authority
     OR NEW.money_movement_authority
     OR NEW.pricing_authority
     OR NEW.legal_policy_authority THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'product_engineering_head_prohibited_authority';
  END IF;
  IF NEW.enabled THEN
    IF NEW.execution_mode NOT IN ('shadow', 'supervised_read_only')
       OR NEW.kill_switch_engaged
       OR NEW.activated_by IS NULL
       OR jsonb_typeof(NEW.activation_evidence) <> 'object'
       OR NEW.activation_evidence = '{}'::jsonb THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'product_engineering_head_activation_invalid';
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
        MESSAGE = 'product_engineering_head_activation_actor_not_tenant_admin';
    END IF;
  ELSIF NEW.execution_mode <> 'disabled' THEN
    RAISE EXCEPTION 'product_engineering_head_disabled_mode_invalid';
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.kill_switch_engaged = true
     AND NEW.kill_switch_engaged = false THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'product_engineering_head_kill_switch_is_one_way';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_product_engineering_head_control_guard
  ON public.product_engineering_head_controls;
CREATE TRIGGER trg_product_engineering_head_control_guard
  BEFORE INSERT OR UPDATE ON public.product_engineering_head_controls
  FOR EACH ROW EXECUTE FUNCTION public.product_engineering_head_control_guard();

ALTER TABLE public.product_engineering_head_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_engineering_outcome_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_engineering_head_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_engineering_head_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_engineering_head_events ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'product_engineering_head_controls',
    'product_engineering_outcome_receipts',
    'product_engineering_head_reports',
    'product_engineering_head_cases', 'product_engineering_head_events'
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
          '''client_owner'', ''tenant_owner'', ''engineering_operator''' ||
        ')' ||
      ')',
      'tenant_iso_' || table_name, table_name
    );
  END LOOP;
END $$;

GRANT SELECT ON
  public.product_engineering_head_controls,
  public.product_engineering_outcome_receipts,
  public.product_engineering_head_reports,
  public.product_engineering_head_cases,
  public.product_engineering_head_events
TO authenticated, service_role;
REVOKE INSERT, UPDATE, DELETE ON
  public.product_engineering_head_controls,
  public.product_engineering_outcome_receipts,
  public.product_engineering_head_reports,
  public.product_engineering_head_cases,
  public.product_engineering_head_events
FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.product_engineering_head_validate_actor(
  p_tenant_id uuid,
  p_actor_type text,
  p_actor_id text,
  p_authority_tier text,
  p_registered_head_id text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor_uuid uuid;
  v_actor_role text;
BEGIN
  IF p_actor_type NOT IN ('human', 'agent', 'service', 'system')
     OR p_authority_tier NOT IN (
       'system', 'operator', 'department_head', 'owner'
     ) THEN
    RAISE EXCEPTION 'product_engineering_head_actor_invalid';
  END IF;
  IF p_actor_type = 'system' THEN
    IF p_actor_id IS NOT NULL OR p_authority_tier <> 'system' THEN
      RAISE EXCEPTION 'product_engineering_head_system_actor_invalid';
    END IF;
    RETURN NULL;
  ELSIF p_actor_type = 'service' THEN
    IF char_length(btrim(COALESCE(p_actor_id, ''))) NOT BETWEEN 2 AND 160
       OR p_authority_tier <> 'system' THEN
      RAISE EXCEPTION 'product_engineering_head_service_actor_invalid';
    END IF;
    RETURN NULL;
  ELSIF p_actor_type = 'agent' THEN
    IF char_length(btrim(COALESCE(p_actor_id, ''))) NOT BETWEEN 3 AND 160
       OR p_authority_tier <> 'department_head'
       OR p_actor_id IS DISTINCT FROM p_registered_head_id THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'product_engineering_head_agent_identity_mismatch';
    END IF;
    RETURN NULL;
  END IF;

  IF p_actor_id !~
    '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
    OR p_authority_tier NOT IN ('operator', 'owner') THEN
    RAISE EXCEPTION 'product_engineering_head_human_actor_invalid';
  END IF;
  v_actor_uuid := p_actor_id::uuid;
  SELECT tenant_user.role INTO v_actor_role
    FROM public.tenant_users tenant_user
   WHERE tenant_user.tenant_id = p_tenant_id
     AND tenant_user.user_id = v_actor_uuid;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'product_engineering_head_human_not_tenant_member';
  END IF;
  IF p_authority_tier = 'owner' AND v_actor_role NOT IN (
    'owner', 'platform_owner', 'founder', 'admin',
    'client_owner', 'tenant_owner'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'product_engineering_head_owner_role_required';
  END IF;
  RETURN v_actor_uuid;
END;
$$;

CREATE OR REPLACE FUNCTION public.product_engineering_outcome_receipt_rpc(
  p_tenant_id uuid,
  p_product_tenant_id uuid,
  p_receipt_id uuid,
  p_outcome_state text,
  p_measurement_digest text,
  p_observed_at timestamptz,
  p_evidence jsonb,
  p_idempotency_key text,
  p_request_fingerprint text,
  p_verified_by_user_id uuid,
  p_expected_control_revision bigint,
  p_feature_gate_enabled boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_claims text;
  v_role text;
  v_control public.product_engineering_head_controls%ROWTYPE;
  v_existing public.product_engineering_outcome_receipts%ROWTYPE;
  v_receipt public.product_engineering_outcome_receipts%ROWTYPE;
  v_evidence_digest text;
  v_semantic text;
BEGIN
  v_claims := NULLIF(current_setting('request.jwt.claims', true), '');
  v_role := COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    CASE WHEN v_claims IS NOT NULL THEN v_claims::jsonb ->> 'role' END,
    session_user::text
  );
  IF v_role IS DISTINCT FROM 'authenticated'
     OR auth.uid() IS NULL
     OR auth.uid() IS DISTINCT FROM p_verified_by_user_id
     OR NULLIF(auth.jwt()->'app_metadata'->>'tenant_id', '')::uuid
       IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'product_engineering_head_authenticated_outcome_owner_required';
  END IF;
  IF p_feature_gate_enabled IS DISTINCT FROM true THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'product_engineering_head_writes_disabled';
  END IF;
  IF p_tenant_id IS NULL OR p_product_tenant_id IS NULL
     OR p_receipt_id IS NULL OR p_verified_by_user_id IS NULL
     OR p_product_tenant_id IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'product_engineering_head_outcome_receipt_identity_invalid';
  END IF;
  SELECT control.* INTO v_control
    FROM public.product_engineering_head_controls control
   WHERE control.tenant_id = p_tenant_id
   FOR SHARE;
  IF NOT FOUND OR v_control.enabled IS DISTINCT FROM true
     OR v_control.execution_mode NOT IN ('shadow', 'supervised_read_only') THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'product_engineering_head_tenant_not_enabled';
  END IF;
  IF v_control.kill_switch_engaged IS DISTINCT FROM false THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'product_engineering_head_kill_switch_engaged';
  END IF;
  IF v_control.revision IS DISTINCT FROM p_expected_control_revision THEN
    RAISE EXCEPTION USING ERRCODE = '40001',
      MESSAGE = 'product_engineering_head_control_revision_conflict';
  END IF;
  IF v_control.code_merge_authority OR v_control.deployment_authority
     OR v_control.migration_apply_authority
     OR v_control.feature_activation_authority
     OR v_control.release_authority
     OR v_control.external_provider_authority
     OR v_control.customer_communication_authority
     OR v_control.money_movement_authority
     OR v_control.pricing_authority
     OR v_control.legal_policy_authority THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'product_engineering_head_prohibited_authority';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.tenant_users tenant_user
     WHERE tenant_user.tenant_id = p_tenant_id
       AND tenant_user.user_id = p_verified_by_user_id
       AND tenant_user.role IN (
         'owner', 'platform_owner', 'founder', 'client_owner', 'tenant_owner'
       )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'product_engineering_head_outcome_owner_role_required';
  END IF;
  IF lower(p_verified_by_user_id::text)
     = lower(btrim(v_control.registered_head_id)) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'product_engineering_head_outcome_verifier_must_be_independent';
  END IF;
  IF p_outcome_state NOT IN ('achieved', 'not_achieved')
     OR p_measurement_digest !~ '^[a-f0-9]{64}$'
     OR p_observed_at IS NULL
     OR p_observed_at > now() + interval '5 minutes'
     OR jsonb_typeof(COALESCE(p_evidence, 'null'::jsonb)) <> 'object'
     OR NOT p_evidence ?& ARRAY[
       'source_type', 'source_id', 'observed_at', 'measurement_digest'
     ]
     OR p_evidence - ARRAY[
       'source_type', 'source_id', 'observed_at', 'measurement_digest'
     ] <> '{}'::jsonb
     OR p_evidence->>'source_type' <> 'owner_verified_product_outcome'
     OR p_evidence->>'source_id' IS DISTINCT FROM p_receipt_id::text
     OR p_evidence->>'measurement_digest' IS DISTINCT FROM p_measurement_digest
     OR NULLIF(btrim(p_evidence->>'observed_at'), '') IS NULL
     OR char_length(btrim(COALESCE(p_idempotency_key, '')))
       NOT BETWEEN 8 AND 200
     OR p_request_fingerprint !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'product_engineering_head_outcome_receipt_invalid';
  END IF;
  BEGIN
    IF (p_evidence->>'observed_at')::timestamptz IS DISTINCT FROM p_observed_at THEN
      RAISE EXCEPTION 'product_engineering_head_outcome_receipt_invalid';
    END IF;
  EXCEPTION WHEN invalid_datetime_format THEN
    RAISE EXCEPTION 'product_engineering_head_outcome_receipt_invalid';
  END;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_tenant_id::text || ':product-engineering-outcome-receipt:' ||
    p_receipt_id::text, 0
  ));
  v_evidence_digest := encode(digest(p_evidence::text, 'sha256'), 'hex');
  v_semantic := encode(digest(concat_ws('|',
    p_tenant_id::text, p_product_tenant_id::text, p_receipt_id::text,
    p_outcome_state, p_measurement_digest, p_observed_at::text,
    p_evidence::text, p_verified_by_user_id::text,
    p_expected_control_revision::text
  ), 'sha256'), 'hex');
  SELECT receipt.* INTO v_existing
    FROM public.product_engineering_outcome_receipts receipt
   WHERE receipt.tenant_id = p_tenant_id
     AND receipt.idempotency_key = btrim(p_idempotency_key);
  IF FOUND THEN
    IF v_existing.id IS DISTINCT FROM p_receipt_id
       OR v_existing.request_fingerprint IS DISTINCT FROM p_request_fingerprint
       OR v_existing.semantic_fingerprint IS DISTINCT FROM v_semantic THEN
      RAISE EXCEPTION USING ERRCODE = '23505',
        MESSAGE = 'product_engineering_head_idempotency_conflict';
    END IF;
    RETURN jsonb_build_object('outcome', 'replay', 'receipt', to_jsonb(v_existing));
  END IF;
  INSERT INTO public.product_engineering_outcome_receipts (
    id, tenant_id, product_tenant_id, outcome_state, measurement_digest,
    observed_at, verified_by_user_id, evidence, evidence_digest,
    idempotency_key, request_fingerprint, semantic_fingerprint
  ) VALUES (
    p_receipt_id, p_tenant_id, p_product_tenant_id, p_outcome_state,
    p_measurement_digest, p_observed_at, p_verified_by_user_id, p_evidence,
    v_evidence_digest, btrim(p_idempotency_key), p_request_fingerprint,
    v_semantic
  )
  RETURNING * INTO v_receipt;
  RETURN jsonb_build_object('outcome', 'accepted', 'receipt', to_jsonb(v_receipt));
END;
$$;

CREATE OR REPLACE FUNCTION public.product_engineering_head_report_rpc(
  p_tenant_id uuid,
  p_product_tenant_id uuid,
  p_report_id uuid,
  p_source_evidence_id uuid,
  p_source_run_id uuid,
  p_report_type text,
  p_product_scope text,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_execution_health_state text,
  p_product_outcome_state text,
  p_outcome_verified boolean,
  p_kpi_results jsonb,
  p_report_body jsonb,
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
  v_role text;
  v_control public.product_engineering_head_controls%ROWTYPE;
  v_existing public.product_engineering_head_reports%ROWTYPE;
  v_report public.product_engineering_head_reports%ROWTYPE;
  v_receipt public.product_engineering_outcome_receipts%ROWTYPE;
  v_actor_uuid uuid;
  v_actor_role text;
  v_observed_at timestamptz;
  v_evidence_digest text;
  v_semantic text;
  v_bad_kpis integer;
  v_bad_shape integer;
  v_evidence_source jsonb;
  v_source_observed_at timestamptz;
BEGIN
  v_claims := NULLIF(current_setting('request.jwt.claims', true), '');
  v_role := COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    CASE WHEN v_claims IS NOT NULL THEN v_claims::jsonb ->> 'role' END,
    session_user::text
  );
  IF v_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'product_engineering_head_requires_service_role';
  END IF;
  IF p_feature_gate_enabled IS DISTINCT FROM true THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'product_engineering_head_writes_disabled';
  END IF;
  IF p_tenant_id IS NULL OR p_product_tenant_id IS NULL
     OR p_report_id IS NULL OR p_source_evidence_id IS NULL THEN
    RAISE EXCEPTION 'product_engineering_head_report_identity_required';
  END IF;
  IF p_product_tenant_id IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'product_engineering_head_cross_tenant_report_forbidden';
  END IF;
  IF p_expected_control_revision IS NULL OR p_expected_control_revision < 0 THEN
    RAISE EXCEPTION 'product_engineering_head_control_revision_invalid';
  END IF;
  IF p_report_type NOT IN (
       'reliability_quality', 'change_throughput',
       'regression_isolation', 'incident_rollback',
       'accessibility_security', 'product_outcome'
     )
     OR p_product_scope NOT IN (
       'web', 'mobile', 'backend', 'data',
       'agents', 'platform', 'portfolio'
     )
     OR p_execution_health_state NOT IN (
       'unknown', 'healthy', 'degraded', 'failed'
     )
     OR p_product_outcome_state NOT IN (
       'unknown', 'unproven', 'achieved', 'not_achieved'
     )
     OR p_period_start IS NULL OR p_period_end <= p_period_start THEN
    RAISE EXCEPTION 'product_engineering_head_report_contract_invalid';
  END IF;
  IF (p_report_type <> 'product_outcome'
      AND p_product_outcome_state NOT IN ('unknown', 'unproven'))
     OR (
       p_product_outcome_state IN ('achieved', 'not_achieved')
       AND p_outcome_verified IS DISTINCT FROM true
     )
     OR (
       p_product_outcome_state IN ('unknown', 'unproven')
       AND p_outcome_verified IS DISTINCT FROM false
     ) THEN
    RAISE EXCEPTION 'product_engineering_head_outcome_verification_invalid';
  END IF;
  IF jsonb_typeof(COALESCE(p_kpi_results, 'null'::jsonb)) <> 'array'
     OR jsonb_array_length(p_kpi_results) = 0
     OR jsonb_typeof(COALESCE(p_report_body, 'null'::jsonb)) <> 'object'
     OR p_report_body = '{}'::jsonb
     OR jsonb_typeof(COALESCE(p_evidence, 'null'::jsonb)) <> 'object'
     OR p_evidence = '{}'::jsonb
     OR jsonb_typeof(COALESCE(p_evidence->'sources', 'null'::jsonb)) <> 'array'
     OR jsonb_array_length(p_evidence->'sources') NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION 'product_engineering_head_report_structure_invalid';
  END IF;
  IF p_evidence - ARRAY[
       'source_type', 'source_id', 'observed_at', 'sources'
     ] <> '{}'::jsonb
     OR p_report_body - ARRAY[
       'summary', 'findings', 'exceptions', 'recommendations'
     ] <> '{}'::jsonb
     OR jsonb_typeof(p_report_body->'summary') IS DISTINCT FROM 'string'
     OR char_length(btrim(p_report_body->>'summary')) NOT BETWEEN 3 AND 2000
     OR EXISTS (
       SELECT 1
         FROM jsonb_each(p_report_body) section
        WHERE section.key <> 'summary'
          AND (
            jsonb_typeof(section.value) <> 'array'
            OR EXISTS (
              SELECT 1
                FROM jsonb_array_elements(section.value) item
               WHERE jsonb_typeof(item) <> 'string'
                  OR char_length(btrim(item #>> '{}')) NOT BETWEEN 1 AND 1000
            )
          )
     ) THEN
    RAISE EXCEPTION 'product_engineering_head_report_shape_invalid';
  END IF;
  IF char_length(btrim(COALESCE(p_evidence->>'source_id', '')))
       NOT BETWEEN 3 AND 240
     OR p_evidence->>'source_type' <> 'engineering_evidence_manifest'
     OR NULLIF(btrim(p_evidence->>'observed_at'), '') IS NULL THEN
    RAISE EXCEPTION 'product_engineering_head_evidence_invalid';
  END IF;
  BEGIN
    v_observed_at := (p_evidence->>'observed_at')::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'product_engineering_head_evidence_time_invalid';
  END;
  IF v_observed_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'product_engineering_head_evidence_from_future';
  END IF;
  SELECT count(*) INTO v_bad_kpis
    FROM jsonb_array_elements(p_evidence->'sources') source
   WHERE jsonb_typeof(source) <> 'object'
      OR source - ARRAY[
        'source_type', 'source_id', 'source_tenant_id', 'digest', 'observed_at'
      ] <> '{}'::jsonb
      OR source->>'source_type' NOT IN (
        'automated_test_run', 'tenant_isolation_gate', 'security_scan',
        'accessibility_audit', 'deployment_readiness_check',
        'rollback_drill', 'incident_postmortem', 'product_outcome_receipt'
      )
      OR char_length(btrim(COALESCE(source->>'source_id', '')))
           NOT BETWEEN 3 AND 240
      OR source->>'source_tenant_id' IS DISTINCT FROM p_tenant_id::text
      OR COALESCE(source->>'digest', '') !~ '^[a-f0-9]{64}$'
      OR NULLIF(btrim(source->>'observed_at'), '') IS NULL;
  IF v_bad_kpis <> 0 OR (
    SELECT count(DISTINCT concat_ws(
      ':', source->>'source_type', source->>'source_id'
    ))
      FROM jsonb_array_elements(p_evidence->'sources') source
  ) <> jsonb_array_length(p_evidence->'sources')
     OR NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_evidence->'sources') source
        WHERE source->>'source_id' = p_source_evidence_id::text
     )
     OR (
       p_source_run_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(p_evidence->'sources') source
          WHERE source->>'source_id' = p_source_run_id::text
       )
  ) THEN
    RAISE EXCEPTION 'product_engineering_head_evidence_manifest_invalid';
  END IF;
  FOR v_evidence_source IN
    SELECT value FROM jsonb_array_elements(p_evidence->'sources')
  LOOP
    BEGIN
      v_source_observed_at :=
        (v_evidence_source->>'observed_at')::timestamptz;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'product_engineering_head_source_time_invalid';
    END;
    IF v_source_observed_at > now() + interval '5 minutes' THEN
      RAISE EXCEPTION 'product_engineering_head_source_from_future';
    END IF;
  END LOOP;
  IF (
       p_report_type = 'reliability_quality'
       AND NOT p_evidence->'sources'
         @> '[{"source_type":"automated_test_run"}]'::jsonb
     ) OR (
       p_report_type = 'change_throughput'
       AND NOT p_evidence->'sources'
         @> '[{"source_type":"deployment_readiness_check"}]'::jsonb
     ) OR (
       p_report_type = 'regression_isolation'
       AND (
         NOT p_evidence->'sources'
           @> '[{"source_type":"automated_test_run"}]'::jsonb
         OR NOT p_evidence->'sources'
           @> '[{"source_type":"tenant_isolation_gate"}]'::jsonb
       )
     ) OR (
       p_report_type = 'incident_rollback'
       AND NOT p_evidence->'sources'
         @> '[{"source_type":"rollback_drill"}]'::jsonb
     ) OR (
       p_report_type = 'accessibility_security'
       AND (
         NOT p_evidence->'sources'
           @> '[{"source_type":"accessibility_audit"}]'::jsonb
         OR NOT p_evidence->'sources'
           @> '[{"source_type":"security_scan"}]'::jsonb
       )
     ) OR (
       p_report_type = 'product_outcome'
       AND NOT p_evidence->'sources'
         @> '[{"source_type":"product_outcome_receipt"}]'::jsonb
     ) THEN
    RAISE EXCEPTION 'product_engineering_head_authoritative_evidence_required';
  END IF;
  IF char_length(btrim(COALESCE(p_idempotency_key, ''))) NOT BETWEEN 8 AND 200
     OR p_request_fingerprint !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'product_engineering_head_idempotency_invalid';
  END IF;

  SELECT control.* INTO v_control
    FROM public.product_engineering_head_controls control
   WHERE control.tenant_id = p_tenant_id
   FOR SHARE;
  IF NOT FOUND OR v_control.enabled IS DISTINCT FROM true
     OR v_control.execution_mode NOT IN ('shadow', 'supervised_read_only') THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'product_engineering_head_tenant_not_enabled';
  END IF;
  IF v_control.kill_switch_engaged IS DISTINCT FROM false THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'product_engineering_head_kill_switch_engaged';
  END IF;
  IF v_control.revision IS DISTINCT FROM p_expected_control_revision THEN
    RAISE EXCEPTION USING ERRCODE = '40001',
      MESSAGE = 'product_engineering_head_control_revision_conflict';
  END IF;
  IF p_report_type <> ALL(v_control.accepted_report_types) THEN
    RAISE EXCEPTION 'product_engineering_head_report_type_not_accepted';
  END IF;
  IF v_control.code_merge_authority OR v_control.deployment_authority
     OR v_control.migration_apply_authority
     OR v_control.feature_activation_authority
     OR v_control.release_authority
     OR v_control.external_provider_authority
     OR v_control.customer_communication_authority
     OR v_control.money_movement_authority
     OR v_control.pricing_authority
     OR v_control.legal_policy_authority THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'product_engineering_head_prohibited_authority';
  END IF;
  v_actor_uuid := public.product_engineering_head_validate_actor(
    p_tenant_id, p_actor_type, p_actor_id, p_authority_tier,
    v_control.registered_head_id
  );
  IF p_actor_type = 'human' AND p_authority_tier = 'operator' THEN
    SELECT tenant_user.role INTO v_actor_role
      FROM public.tenant_users tenant_user
     WHERE tenant_user.tenant_id = p_tenant_id
       AND tenant_user.user_id = v_actor_uuid;
    IF v_actor_role NOT IN (
      'engineering_operator', 'manager', 'owner', 'platform_owner',
      'founder', 'admin', 'client_owner', 'tenant_owner'
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '42501',
        MESSAGE = 'product_engineering_head_report_operator_role_required';
    END IF;
  END IF;

  SELECT count(*) INTO v_bad_kpis
    FROM jsonb_array_elements(p_kpi_results) result
   WHERE jsonb_typeof(result) <> 'object'
      OR result - ARRAY[
        'kpi_key', 'measured_value', 'verification_state', 'evidence_ref'
      ] <> '{}'::jsonb
      OR result->>'kpi_key' !~ '^[a-z][a-z0-9_]{2,79}$'
      OR result->>'verification_state' NOT IN (
        'verified', 'unverified', 'unknown'
      );
  IF v_bad_kpis <> 0 OR (
    SELECT count(DISTINCT result->>'kpi_key')
      FROM jsonb_array_elements(p_kpi_results) result
  ) <> jsonb_array_length(p_kpi_results) THEN
    RAISE EXCEPTION 'product_engineering_head_kpi_contract_invalid';
  END IF;
  IF (
       p_report_type = 'reliability_quality'
       AND NOT p_kpi_results
         @> '[{"kpi_key":"reliability_quality_pass_rate"}]'::jsonb
     ) OR (
       p_report_type = 'change_throughput'
       AND (
         NOT p_kpi_results
           @> '[{"kpi_key":"change_lead_time_hours"}]'::jsonb
         OR NOT p_kpi_results
           @> '[{"kpi_key":"change_throughput_rate"}]'::jsonb
       )
     ) OR (
       p_report_type = 'regression_isolation'
       AND (
         NOT p_kpi_results
           @> '[{"kpi_key":"regression_escape_rate"}]'::jsonb
         OR NOT p_kpi_results
           @> '[{"kpi_key":"tenant_isolation_gate_pass_rate"}]'::jsonb
       )
     ) OR (
       p_report_type = 'incident_rollback'
       AND (
         NOT p_kpi_results
           @> '[{"kpi_key":"incident_escape_rate"}]'::jsonb
         OR NOT p_kpi_results
           @> '[{"kpi_key":"rollback_readiness_rate"}]'::jsonb
       )
     ) OR (
       p_report_type = 'accessibility_security'
       AND (
         NOT p_kpi_results
           @> '[{"kpi_key":"accessibility_debt_count"}]'::jsonb
         OR NOT p_kpi_results
           @> '[{"kpi_key":"security_debt_count"}]'::jsonb
       )
     ) OR (
       p_report_type = 'product_outcome'
       AND NOT p_kpi_results
         @> '[{"kpi_key":"product_outcome_achievement_rate"}]'::jsonb
     ) THEN
    RAISE EXCEPTION 'product_engineering_head_kpi_contract_incomplete';
  END IF;
  IF p_product_outcome_state IN ('achieved', 'not_achieved') THEN
    SELECT count(*) INTO v_bad_kpis
      FROM jsonb_array_elements(p_kpi_results) result
     WHERE result->>'verification_state' <> 'verified'
        OR NULLIF(btrim(result->>'evidence_ref'), '') IS NULL;
    IF v_bad_kpis <> 0
       OR NOT p_kpi_results
         @> '[{"kpi_key":"product_outcome_achievement_rate"}]'::jsonb THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'product_engineering_head_false_product_outcome_forbidden';
    END IF;
    SELECT receipt.* INTO v_receipt
      FROM public.product_engineering_outcome_receipts receipt
     WHERE receipt.id = p_source_evidence_id
       AND receipt.tenant_id = p_tenant_id
       AND receipt.product_tenant_id = p_product_tenant_id
       AND receipt.outcome_state = p_product_outcome_state;
    IF NOT FOUND
       OR NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements(p_evidence->'sources') source
          WHERE source->>'source_type' = 'product_outcome_receipt'
            AND source->>'source_id' = v_receipt.id::text
            AND source->>'source_tenant_id' = v_receipt.tenant_id::text
            AND source->>'digest' = v_receipt.evidence_digest
            AND (source->>'observed_at')::timestamptz = v_receipt.observed_at
       )
       OR EXISTS (
         SELECT 1
           FROM jsonb_array_elements(p_kpi_results) result
          WHERE result->>'evidence_ref' IS DISTINCT FROM
            ('product_outcome_receipt:' || v_receipt.id::text)
       ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'product_engineering_head_canonical_outcome_receipt_required';
    END IF;
  ELSIF p_report_type = 'product_outcome' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'product_engineering_head_product_outcome_must_be_proven';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      p_tenant_id::text || ':product-engineering-head:report:' || p_source_evidence_id::text, 0
    )
  );
  v_evidence_digest := encode(digest(p_evidence::text, 'sha256'), 'hex');
  v_semantic := encode(digest(concat_ws('|',
    p_tenant_id::text, p_product_tenant_id::text, p_report_id::text,
    p_source_evidence_id::text, COALESCE(p_source_run_id::text, ''), p_report_type,
    p_product_scope, p_period_start::text, p_period_end::text,
    p_execution_health_state,
    p_product_outcome_state, p_outcome_verified::text, p_kpi_results::text,
    p_report_body::text, p_evidence::text, p_actor_type,
    COALESCE(p_actor_id, ''), p_authority_tier,
    p_expected_control_revision::text
  ), 'sha256'), 'hex');

  SELECT report.* INTO v_existing
    FROM public.product_engineering_head_reports report
   WHERE report.tenant_id = p_tenant_id
     AND report.idempotency_key = btrim(p_idempotency_key);
  IF FOUND THEN
    IF v_existing.id IS DISTINCT FROM p_report_id
       OR v_existing.product_tenant_id IS DISTINCT FROM p_product_tenant_id
       OR v_existing.request_fingerprint IS DISTINCT FROM p_request_fingerprint
       OR v_existing.semantic_fingerprint IS DISTINCT FROM v_semantic THEN
      RAISE EXCEPTION USING ERRCODE = '23505',
        MESSAGE = 'product_engineering_head_idempotency_conflict';
    END IF;
    RETURN jsonb_build_object('outcome', 'replay', 'report', to_jsonb(v_existing));
  END IF;

  INSERT INTO public.product_engineering_head_reports (
    id, tenant_id, product_tenant_id, source_evidence_id, source_run_id,
    product_outcome_receipt_id,
    report_type, product_scope, period_start, period_end,
    execution_health_state, product_outcome_state,
    outcome_verified, kpi_results, report_body, evidence, evidence_digest,
    evidence_observed_at, accepted_by_type, accepted_by_id,
    accepted_authority_tier, idempotency_key, request_fingerprint,
    semantic_fingerprint
  ) VALUES (
    p_report_id, p_tenant_id, p_product_tenant_id, p_source_evidence_id,
    p_source_run_id,
    CASE WHEN p_report_type = 'product_outcome' THEN v_receipt.id ELSE NULL END,
    p_report_type, p_product_scope, p_period_start,
    p_period_end, p_execution_health_state,
    p_product_outcome_state, p_outcome_verified, p_kpi_results, p_report_body,
    p_evidence, v_evidence_digest, v_observed_at, p_actor_type, p_actor_id,
    p_authority_tier, btrim(p_idempotency_key), p_request_fingerprint, v_semantic
  )
  RETURNING * INTO v_report;
  RETURN jsonb_build_object('outcome', 'accepted', 'report', to_jsonb(v_report));
END;
$$;

CREATE OR REPLACE FUNCTION public.product_engineering_head_case_command_rpc(
  p_tenant_id uuid,
  p_product_tenant_id uuid,
  p_case_id uuid,
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
  p_source_report_id uuid DEFAULT NULL,
  p_owner_id uuid DEFAULT NULL,
  p_assignee_id uuid DEFAULT NULL,
  p_sla_due_at timestamptz DEFAULT NULL,
  p_title text DEFAULT NULL,
  p_contract jsonb DEFAULT NULL,
  p_escalation_code text DEFAULT NULL,
  p_product_outcome_state text DEFAULT NULL,
  p_decision text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_claims text;
  v_role text;
  v_control public.product_engineering_head_controls%ROWTYPE;
  v_case public.product_engineering_head_cases%ROWTYPE;
  v_existing public.product_engineering_head_events%ROWTYPE;
  v_event public.product_engineering_head_events%ROWTYPE;
  v_actor_uuid uuid;
  v_type text;
  v_previous_state text;
  v_next_state text;
  v_previous_outcome text;
  v_next_outcome text;
  v_accepted_at timestamptz;
  v_escalated_at timestamptz;
  v_escalation text;
  v_completed_at timestamptz;
  v_completion_digest text;
  v_outcome_digest text;
  v_outcome_at timestamptz;
  v_product_outcome_receipt_id uuid;
  v_observed_at timestamptz;
  v_evidence_digest text;
  v_semantic text;
BEGIN
  v_claims := NULLIF(current_setting('request.jwt.claims', true), '');
  v_role := COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    CASE WHEN v_claims IS NOT NULL THEN v_claims::jsonb ->> 'role' END,
    session_user::text
  );
  IF v_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'product_engineering_head_requires_service_role';
  END IF;
  IF p_feature_gate_enabled IS DISTINCT FROM true THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'product_engineering_head_writes_disabled';
  END IF;
  IF p_tenant_id IS NULL OR p_product_tenant_id IS NULL OR p_case_id IS NULL THEN
    RAISE EXCEPTION 'product_engineering_head_case_identity_required';
  END IF;
  IF p_product_tenant_id IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'product_engineering_head_cross_tenant_case_forbidden';
  END IF;
  IF p_action NOT IN (
    'create_goal', 'complete_goal', 'create_work', 'accept_work',
    'escalate_work', 'complete_work', 'record_product_outcome',
    'recommend_decision', 'decide_recommendation',
    'raise_exception', 'resolve_exception'
  ) THEN
    RAISE EXCEPTION 'product_engineering_head_action_invalid';
  END IF;
  IF p_expected_revision IS NULL OR p_expected_revision < 0
     OR p_expected_control_revision IS NULL OR p_expected_control_revision < 0
     OR char_length(btrim(COALESCE(p_idempotency_key, '')))
       NOT BETWEEN 8 AND 200
     OR p_request_fingerprint !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'product_engineering_head_command_contract_invalid';
  END IF;
  IF jsonb_typeof(COALESCE(p_evidence, 'null'::jsonb)) <> 'object'
     OR p_evidence = '{}'::jsonb
     OR p_evidence - ARRAY[
       'source_type', 'source_id', 'observed_at'
     ] <> '{}'::jsonb
     OR char_length(btrim(COALESCE(p_evidence->>'source_type', '')))
       NOT BETWEEN 3 AND 60
     OR char_length(btrim(COALESCE(p_evidence->>'source_id', '')))
       NOT BETWEEN 3 AND 240
     OR NULLIF(btrim(p_evidence->>'observed_at'), '') IS NULL THEN
    RAISE EXCEPTION 'product_engineering_head_evidence_invalid';
  END IF;
  BEGIN
    v_observed_at := (p_evidence->>'observed_at')::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'product_engineering_head_evidence_time_invalid';
  END;
  IF v_observed_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'product_engineering_head_evidence_from_future';
  END IF;

  SELECT control.* INTO v_control
    FROM public.product_engineering_head_controls control
   WHERE control.tenant_id = p_tenant_id
   FOR SHARE;
  IF NOT FOUND OR v_control.enabled IS DISTINCT FROM true
     OR v_control.execution_mode NOT IN ('shadow', 'supervised_read_only') THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'product_engineering_head_tenant_not_enabled';
  END IF;
  IF v_control.kill_switch_engaged IS DISTINCT FROM false THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'product_engineering_head_kill_switch_engaged';
  END IF;
  IF v_control.revision IS DISTINCT FROM p_expected_control_revision THEN
    RAISE EXCEPTION USING ERRCODE = '40001',
      MESSAGE = 'product_engineering_head_control_revision_conflict';
  END IF;
  IF v_control.code_merge_authority OR v_control.deployment_authority
     OR v_control.migration_apply_authority
     OR v_control.feature_activation_authority
     OR v_control.release_authority
     OR v_control.external_provider_authority
     OR v_control.customer_communication_authority
     OR v_control.money_movement_authority
     OR v_control.pricing_authority
     OR v_control.legal_policy_authority THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'product_engineering_head_prohibited_authority';
  END IF;
  v_actor_uuid := public.product_engineering_head_validate_actor(
    p_tenant_id, p_actor_type, p_actor_id, p_authority_tier,
    v_control.registered_head_id
  );

  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_tenant_id::text || ':product-engineering-head:case:' || p_case_id::text, 0
  ));
  v_evidence_digest := encode(digest(p_evidence::text, 'sha256'), 'hex');
  v_semantic := encode(digest(concat_ws('|',
    p_tenant_id::text, p_product_tenant_id::text, p_case_id::text, p_action,
    p_expected_revision::text, p_expected_control_revision::text,
    COALESCE(p_source_report_id::text, ''), COALESCE(p_owner_id::text, ''),
    COALESCE(p_assignee_id::text, ''), COALESCE(p_sla_due_at::text, ''),
    COALESCE(p_title, ''), COALESCE(p_contract::text, ''),
    COALESCE(p_escalation_code, ''), COALESCE(p_product_outcome_state, ''),
    COALESCE(p_decision, ''), p_actor_type, COALESCE(p_actor_id, ''),
    p_authority_tier, p_evidence::text
  ), 'sha256'), 'hex');

  SELECT event.* INTO v_existing
    FROM public.product_engineering_head_events event
   WHERE event.tenant_id = p_tenant_id
     AND event.idempotency_key = btrim(p_idempotency_key);
  IF FOUND THEN
    IF v_existing.product_tenant_id IS DISTINCT FROM p_product_tenant_id
       OR v_existing.case_id IS DISTINCT FROM p_case_id
       OR v_existing.action IS DISTINCT FROM p_action
       OR v_existing.request_fingerprint IS DISTINCT FROM p_request_fingerprint
       OR v_existing.semantic_fingerprint IS DISTINCT FROM v_semantic THEN
      RAISE EXCEPTION USING ERRCODE = '23505',
        MESSAGE = 'product_engineering_head_idempotency_conflict';
    END IF;
    SELECT head_case.* INTO STRICT v_case
      FROM public.product_engineering_head_cases head_case
     WHERE head_case.id = p_case_id
       AND head_case.tenant_id = p_tenant_id
       AND head_case.product_tenant_id = p_product_tenant_id;
    RETURN jsonb_build_object(
      'outcome', 'replay', 'case', to_jsonb(v_case),
      'event', to_jsonb(v_existing)
    );
  END IF;

  IF p_action IN (
    'create_goal', 'create_work', 'recommend_decision', 'raise_exception'
  ) THEN
    IF p_expected_revision <> 0 OR p_source_report_id IS NULL
       OR p_owner_id IS NULL OR p_sla_due_at IS NULL
       OR p_sla_due_at <= v_observed_at
       OR char_length(btrim(COALESCE(p_title, ''))) NOT BETWEEN 3 AND 240
       OR jsonb_typeof(COALESCE(p_contract, 'null'::jsonb)) <> 'object'
       OR p_contract = '{}'::jsonb
       OR p_evidence->>'source_type' <> (
         CASE
           WHEN p_action = 'create_goal' THEN 'supervised_goal_contract'
           WHEN p_action = 'create_work' THEN 'supervised_work_contract'
           WHEN p_action = 'recommend_decision' THEN 'engineering_recommendation'
           ELSE 'engineering_exception'
         END
       )
       OR (
         p_action = 'create_goal'
         AND (
           NOT p_contract ?& ARRAY['objective', 'success_criteria']
           OR p_contract - ARRAY[
             'objective', 'success_criteria', 'constraints'
           ] <> '{}'::jsonb
         )
       )
       OR (
         p_action = 'create_work'
         AND (
           NOT p_contract ?& ARRAY['objective', 'acceptance_criteria']
           OR p_contract - ARRAY[
             'objective', 'acceptance_criteria', 'constraints'
           ] <> '{}'::jsonb
         )
       )
       OR (
         p_action = 'recommend_decision'
         AND (
           NOT p_contract ? 'decision_required'
           OR p_contract - ARRAY[
             'decision_required', 'options', 'constraints'
           ] <> '{}'::jsonb
         )
       )
       OR (
         p_action = 'raise_exception'
         AND (
           NOT p_contract ?& ARRAY['exception', 'resolution_criteria']
           OR p_contract - ARRAY[
             'exception', 'resolution_criteria', 'constraints'
           ] <> '{}'::jsonb
         )
       )
       OR EXISTS (
         SELECT 1
           FROM jsonb_each(p_contract) entry
          WHERE jsonb_typeof(entry.value) NOT IN ('string', 'array')
             OR (
               jsonb_typeof(entry.value) = 'string'
               AND char_length(btrim(entry.value #>> '{}')) NOT BETWEEN 1 AND 1000
             )
             OR (
               jsonb_typeof(entry.value) = 'array'
               AND (
                 jsonb_array_length(entry.value) NOT BETWEEN 1 AND 50
                 OR EXISTS (
                   SELECT 1
                     FROM jsonb_array_elements(entry.value) item
                    WHERE jsonb_typeof(item) <> 'string'
                       OR char_length(btrim(item #>> '{}')) NOT BETWEEN 1 AND 500
                 )
               )
             )
       ) THEN
      RAISE EXCEPTION 'product_engineering_head_case_creation_invalid';
    END IF;
    IF p_actor_type = 'human' AND p_authority_tier <> 'owner' THEN
      RAISE EXCEPTION USING ERRCODE = '42501',
        MESSAGE = 'product_engineering_head_action_authority_denied';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.product_engineering_head_reports report
       WHERE report.id = p_source_report_id
         AND report.tenant_id = p_tenant_id
         AND report.product_tenant_id = p_product_tenant_id
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0002',
        MESSAGE = 'product_engineering_head_source_report_not_found_for_identity';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.tenant_users tenant_user
       WHERE tenant_user.tenant_id = p_tenant_id
         AND tenant_user.user_id = p_owner_id
    ) OR (
      p_action = 'create_work' AND (
        p_assignee_id IS NULL OR NOT EXISTS (
          SELECT 1 FROM public.tenant_users tenant_user
           WHERE tenant_user.tenant_id = p_tenant_id
             AND tenant_user.user_id = p_assignee_id
        )
      )
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '42501',
        MESSAGE = 'product_engineering_head_assignment_tenant_mismatch';
    END IF;
    v_type := CASE p_action
      WHEN 'create_goal' THEN 'goal'
      WHEN 'create_work' THEN 'work'
      WHEN 'recommend_decision' THEN 'decision'
      ELSE 'exception'
    END;
    v_next_state := CASE p_action
      WHEN 'create_goal' THEN 'active'
      WHEN 'create_work' THEN 'assigned'
      WHEN 'recommend_decision' THEN 'recommended'
      ELSE 'open'
    END;
    v_next_outcome := CASE
      WHEN v_type = 'decision' THEN 'not_applicable' ELSE 'unknown'
    END;
    INSERT INTO public.product_engineering_head_cases (
      id, tenant_id, product_tenant_id, source_report_id, case_type,
      title, contract, lifecycle_state, product_outcome_state, revision,
      owner_id, assignee_id, assigned_at, sla_due_at, last_action_at
    ) VALUES (
      p_case_id, p_tenant_id, p_product_tenant_id, p_source_report_id, v_type,
      btrim(p_title), p_contract, v_next_state, v_next_outcome, 0, p_owner_id,
      CASE WHEN v_type = 'work' THEN p_assignee_id ELSE NULL END,
      CASE WHEN v_type = 'work' THEN v_observed_at ELSE NULL END,
      p_sla_due_at, v_observed_at
    );
  END IF;

  SELECT head_case.* INTO v_case
    FROM public.product_engineering_head_cases head_case
   WHERE head_case.id = p_case_id
     AND head_case.tenant_id = p_tenant_id
     AND head_case.product_tenant_id = p_product_tenant_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002',
      MESSAGE = 'product_engineering_head_case_not_found_for_identity';
  END IF;
  IF v_case.revision IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION USING ERRCODE = '40001',
      MESSAGE = 'product_engineering_head_revision_conflict';
  END IF;

  v_type := v_case.case_type;
  v_previous_state := v_case.lifecycle_state;
  v_next_state := v_previous_state;
  v_previous_outcome := v_case.product_outcome_state;
  v_next_outcome := v_previous_outcome;
  v_accepted_at := v_case.accepted_at;
  v_escalated_at := v_case.escalated_at;
  v_escalation := v_case.escalation_code;
  v_completed_at := v_case.completed_at;
  v_completion_digest := v_case.completion_evidence_digest;
  v_outcome_digest := v_case.outcome_evidence_digest;
  v_outcome_at := v_case.outcome_observed_at;
  v_product_outcome_receipt_id := v_case.product_outcome_receipt_id;

  CASE p_action
    WHEN 'create_goal' THEN
      IF v_type <> 'goal' OR v_previous_state <> 'active' THEN
        RAISE EXCEPTION 'product_engineering_head_transition_invalid';
      END IF;
    WHEN 'complete_goal' THEN
      IF v_type <> 'goal' OR v_previous_state <> 'active'
         OR (p_actor_type = 'human' AND p_authority_tier <> 'owner')
         OR p_product_outcome_state NOT IN ('achieved', 'not_achieved')
         OR p_evidence->>'source_type' <> 'product_outcome_receipt'
         OR p_source_report_id IS NULL
         OR NOT EXISTS (
           SELECT 1 FROM public.product_engineering_head_reports report
            WHERE report.id = p_source_report_id
              AND report.tenant_id = p_tenant_id
              AND report.product_tenant_id = p_product_tenant_id
              AND report.report_type = 'product_outcome'
              AND report.outcome_verified = true
              AND report.product_outcome_state = p_product_outcome_state
              AND report.product_outcome_receipt_id IS NOT NULL
              AND p_evidence->>'source_id' =
                report.product_outcome_receipt_id::text
         ) THEN
        RAISE EXCEPTION 'product_engineering_head_goal_outcome_invalid';
      END IF;
      v_next_state := 'completed';
      v_next_outcome := p_product_outcome_state;
      v_completed_at := v_observed_at;
      v_completion_digest := v_evidence_digest;
      v_outcome_digest := v_evidence_digest;
      v_outcome_at := v_observed_at;
      SELECT report.product_outcome_receipt_id
        INTO v_product_outcome_receipt_id
        FROM public.product_engineering_head_reports report
       WHERE report.id = p_source_report_id
         AND report.tenant_id = p_tenant_id
         AND report.product_tenant_id = p_product_tenant_id;
    WHEN 'create_work' THEN
      IF v_type <> 'work' OR v_previous_state <> 'assigned' THEN
        RAISE EXCEPTION 'product_engineering_head_transition_invalid';
      END IF;
    WHEN 'accept_work' THEN
      IF v_type <> 'work' OR v_previous_state <> 'assigned'
         OR p_actor_type <> 'human'
         OR v_actor_uuid IS DISTINCT FROM v_case.assignee_id
         OR p_evidence->>'source_type' <> 'assignment_acceptance' THEN
        RAISE EXCEPTION 'product_engineering_head_work_acceptance_invalid';
      END IF;
      v_next_state := 'accepted';
      v_next_outcome := 'unproven';
      v_accepted_at := v_observed_at;
    WHEN 'escalate_work' THEN
      IF v_type <> 'work' OR v_previous_state NOT IN ('assigned', 'accepted')
         OR (
           p_actor_type = 'human'
           AND v_actor_uuid IS DISTINCT FROM v_case.assignee_id
           AND p_authority_tier <> 'owner'
         )
         OR p_escalation_code !~ '^[a-z][a-z0-9_]{2,79}$'
         OR p_evidence->>'source_type' NOT IN (
           'sla_breach', 'operator_escalation'
         ) THEN
        RAISE EXCEPTION 'product_engineering_head_work_escalation_invalid';
      END IF;
      v_next_state := 'escalated';
      v_next_outcome := 'unproven';
      v_escalated_at := v_observed_at;
      v_escalation := p_escalation_code;
    WHEN 'complete_work' THEN
      IF v_type <> 'work' OR v_previous_state NOT IN ('accepted', 'escalated')
         OR p_actor_type <> 'human'
         OR (
           v_actor_uuid IS DISTINCT FROM v_case.assignee_id
           AND p_authority_tier <> 'owner'
         )
         OR p_evidence->>'source_type' <> 'engineering_completion_receipt' THEN
        RAISE EXCEPTION 'product_engineering_head_work_completion_invalid';
      END IF;
      v_next_state := 'completed';
      v_next_outcome := 'unproven';
      v_accepted_at := COALESCE(v_accepted_at, v_observed_at);
      v_completed_at := v_observed_at;
      v_completion_digest := v_evidence_digest;
    WHEN 'record_product_outcome' THEN
      IF v_type <> 'work' OR v_previous_state <> 'completed'
         OR v_previous_outcome <> 'unproven'
         OR (p_actor_type = 'human' AND p_authority_tier <> 'owner')
         OR p_product_outcome_state NOT IN ('achieved', 'not_achieved')
         OR p_evidence->>'source_type' <> 'product_outcome_receipt'
         OR p_source_report_id IS NULL
         OR NOT EXISTS (
           SELECT 1 FROM public.product_engineering_head_reports report
            WHERE report.id = p_source_report_id
              AND report.tenant_id = p_tenant_id
              AND report.product_tenant_id = p_product_tenant_id
              AND report.report_type = 'product_outcome'
              AND report.outcome_verified = true
              AND report.product_outcome_state = p_product_outcome_state
              AND report.product_outcome_receipt_id IS NOT NULL
              AND p_evidence->>'source_id' =
                report.product_outcome_receipt_id::text
         ) THEN
        RAISE EXCEPTION 'product_engineering_head_product_outcome_invalid';
      END IF;
      v_next_outcome := p_product_outcome_state;
      v_outcome_digest := v_evidence_digest;
      v_outcome_at := v_observed_at;
      SELECT report.product_outcome_receipt_id
        INTO v_product_outcome_receipt_id
        FROM public.product_engineering_head_reports report
       WHERE report.id = p_source_report_id
         AND report.tenant_id = p_tenant_id
         AND report.product_tenant_id = p_product_tenant_id;
    WHEN 'recommend_decision' THEN
      IF v_type <> 'decision' OR v_previous_state <> 'recommended' THEN
        RAISE EXCEPTION 'product_engineering_head_transition_invalid';
      END IF;
    WHEN 'decide_recommendation' THEN
      IF v_type <> 'decision' OR v_previous_state <> 'recommended'
         OR p_actor_type <> 'human' OR p_authority_tier <> 'owner'
         OR p_decision NOT IN ('approved', 'rejected')
         OR p_evidence->>'source_type' <> 'human_decision_record' THEN
        RAISE EXCEPTION USING ERRCODE = '42501',
          MESSAGE = 'product_engineering_head_human_decision_required';
      END IF;
      v_next_state := p_decision;
      v_completed_at := v_observed_at;
      v_completion_digest := v_evidence_digest;
    WHEN 'raise_exception' THEN
      IF v_type <> 'exception' OR v_previous_state <> 'open' THEN
        RAISE EXCEPTION 'product_engineering_head_transition_invalid';
      END IF;
    WHEN 'resolve_exception' THEN
      IF v_type <> 'exception' OR v_previous_state NOT IN ('open', 'escalated')
         OR p_actor_type <> 'human' OR p_authority_tier <> 'owner'
         OR p_evidence->>'source_type' <> 'exception_resolution_receipt' THEN
        RAISE EXCEPTION 'product_engineering_head_exception_resolution_invalid';
      END IF;
      v_next_state := 'resolved';
      v_next_outcome := 'not_applicable';
      v_completed_at := v_observed_at;
      v_completion_digest := v_evidence_digest;
  END CASE;

  UPDATE public.product_engineering_head_cases
     SET lifecycle_state = v_next_state,
         product_outcome_state = v_next_outcome,
         accepted_at = v_accepted_at,
         escalated_at = v_escalated_at,
         escalation_code = v_escalation,
         completed_at = v_completed_at,
         completion_evidence_digest = v_completion_digest,
         outcome_evidence_digest = v_outcome_digest,
         outcome_observed_at = v_outcome_at,
         product_outcome_receipt_id = v_product_outcome_receipt_id,
         revision = revision + 1,
         last_action_at = v_observed_at,
         updated_at = now()
   WHERE id = p_case_id AND tenant_id = p_tenant_id
     AND product_tenant_id = p_product_tenant_id
  RETURNING * INTO v_case;

  INSERT INTO public.product_engineering_head_events (
    tenant_id, product_tenant_id, case_id, case_type, action,
    previous_state, next_state, previous_product_outcome,
    next_product_outcome, expected_revision, resulting_revision,
    actor_type, actor_id, authority_tier, evidence, evidence_digest,
    request_fingerprint, semantic_fingerprint, idempotency_key
  ) VALUES (
    p_tenant_id, p_product_tenant_id, p_case_id, v_type, p_action,
    v_previous_state, v_next_state, v_previous_outcome, v_next_outcome,
    p_expected_revision, v_case.revision, p_actor_type, p_actor_id,
    p_authority_tier, p_evidence, v_evidence_digest, p_request_fingerprint,
    v_semantic, btrim(p_idempotency_key)
  )
  RETURNING * INTO v_event;
  RETURN jsonb_build_object(
    'outcome', 'applied', 'case', to_jsonb(v_case), 'event', to_jsonb(v_event)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.product_engineering_head_kill_switch_rpc(
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
  v_role text;
  v_control public.product_engineering_head_controls%ROWTYPE;
BEGIN
  v_claims := NULLIF(current_setting('request.jwt.claims', true), '');
  v_role := COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    CASE WHEN v_claims IS NOT NULL THEN v_claims::jsonb ->> 'role' END,
    session_user::text
  );
  IF v_role IS DISTINCT FROM 'service_role'
     OR p_expected_control_revision IS NULL
     OR p_expected_control_revision < 0
     OR char_length(btrim(COALESCE(p_reason, ''))) NOT BETWEEN 3 AND 240 THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'product_engineering_head_kill_switch_denied';
  END IF;
  UPDATE public.product_engineering_head_controls
     SET enabled = false, execution_mode = 'disabled',
         kill_switch_engaged = true, revision = revision + 1,
         updated_at = now()
   WHERE tenant_id = p_tenant_id
     AND revision = p_expected_control_revision
  RETURNING * INTO v_control;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '40001',
      MESSAGE = 'product_engineering_head_control_revision_conflict';
  END IF;
  RETURN jsonb_build_object(
    'outcome', 'kill_switch_engaged',
    'tenant_id', v_control.tenant_id,
    'revision', v_control.revision,
    'reason_digest', encode(digest(btrim(p_reason), 'sha256'), 'hex')
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.product_engineering_head_validate_actor(
  uuid, text, text, text, text
) FROM PUBLIC, anon, authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.product_engineering_outcome_receipt_rpc(
  uuid, uuid, uuid, text, text, timestamptz, jsonb, text, text, uuid, bigint,
  boolean
) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.product_engineering_outcome_receipt_rpc(
  uuid, uuid, uuid, text, text, timestamptz, jsonb, text, text, uuid, bigint,
  boolean
) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.product_engineering_head_report_rpc(
  uuid, uuid, uuid, uuid, uuid, text, text, timestamptz, timestamptz, text, text,
  boolean, jsonb, jsonb, jsonb, text, text, text, text, text, bigint, boolean
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.product_engineering_head_report_rpc(
  uuid, uuid, uuid, uuid, uuid, text, text, timestamptz, timestamptz, text, text,
  boolean, jsonb, jsonb, jsonb, text, text, text, text, text, bigint, boolean
) TO service_role;

REVOKE EXECUTE ON FUNCTION public.product_engineering_head_case_command_rpc(
  uuid, uuid, uuid, text, bigint, text, text, text, text, text, jsonb, bigint,
  boolean, uuid, uuid, uuid, timestamptz, text, jsonb, text, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.product_engineering_head_case_command_rpc(
  uuid, uuid, uuid, text, bigint, text, text, text, text, text, jsonb, bigint,
  boolean, uuid, uuid, uuid, timestamptz, text, jsonb, text, text, text
) TO service_role;

REVOKE EXECUTE ON FUNCTION public.product_engineering_head_kill_switch_rpc(
  uuid, bigint, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.product_engineering_head_kill_switch_rpc(
  uuid, bigint, text
) TO service_role;
