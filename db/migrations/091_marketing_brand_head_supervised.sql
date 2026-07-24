-- ============================================================================
-- Migration 091: Supervised Marketing & Brand Department Head
-- Date: 2026-07-24
--
-- Additive evidence-only executive control over canonical content artifacts,
-- quality evaluations, and delivery receipts from migration 082. This head
-- cannot publish, contact an audience, dispatch a provider, buy advertising,
-- spend money, or mutate any source record. Completion, quality, delivery, and
-- descriptive business observations remain separate states.
--
-- ROLLBACK: db/rollbacks/091_marketing_brand_head_supervised_rollback.sql
-- ============================================================================

CREATE OR REPLACE FUNCTION public.marketing_brand_json_has_forbidden_key(
  p_value jsonb
) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, public AS $$
DECLARE
  v_key text;
  v_normalized text;
  v_child jsonb;
BEGIN
  IF p_value IS NULL THEN RETURN false; END IF;
  IF jsonb_typeof(p_value) = 'object' THEN
    FOR v_key, v_child IN SELECT key, value FROM jsonb_each(p_value) LOOP
      v_normalized := regexp_replace(lower(v_key), '[^a-z0-9]', '', 'g');
      IF v_normalized = ANY(ARRAY[
        'publish', 'publication', 'contentpublication', 'send', 'dispatch',
        'providerdispatch', 'customercontact', 'customeremail',
        'customerphone', 'email', 'sms', 'mms', 'voice', 'paidadvertising',
        'adspend', 'spend', 'charge', 'refund',
        'transfer', 'pricing', 'legalpolicy', 'productionwrite',
        'providertoken', 'causalclaim', 'attributionmodel', 'qualitystate',
        'deliverystate', 'businesseffectstate', 'authorization', 'apikey',
        'accesstoken', 'refreshtoken', 'password', 'secret', 'credential',
        'cookie', 'setcookie', 'privatekey', 'clientsecret'
      ]) THEN
        RETURN true;
      END IF;
      IF public.marketing_brand_json_has_forbidden_key(v_child) THEN
        RETURN true;
      END IF;
    END LOOP;
  ELSIF jsonb_typeof(p_value) = 'array' THEN
    FOR v_child IN SELECT value FROM jsonb_array_elements(p_value) LOOP
      IF public.marketing_brand_json_has_forbidden_key(v_child) THEN
        RETURN true;
      END IF;
    END LOOP;
  END IF;
  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.marketing_brand_evidence_is_minimized(
  p_evidence jsonb
) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, public AS $$
DECLARE
  v_key text;
  v_value jsonb;
BEGIN
  IF jsonb_typeof(COALESCE(p_evidence, 'null'::jsonb)) <> 'object'
     OR p_evidence = '{}'::jsonb
     OR public.marketing_brand_json_has_forbidden_key(p_evidence)
     OR NOT (p_evidence ?& ARRAY['source_type', 'source_id', 'observed_at'])
     OR char_length(btrim(COALESCE(p_evidence->>'source_type', '')))
        NOT BETWEEN 3 AND 80
     OR char_length(btrim(COALESCE(p_evidence->>'source_id', '')))
        NOT BETWEEN 3 AND 240
     OR p_evidence->>'source_type' !~ '^[a-z][a-z0-9_]{1,79}$'
     OR p_evidence->>'source_id' !~
        '^[A-Za-z0-9][A-Za-z0-9._:/-]{1,239}$' THEN
    RETURN false;
  END IF;
  FOR v_key, v_value IN SELECT key, value FROM jsonb_each(p_evidence) LOOP
    IF v_key NOT IN (
      'source_type', 'source_id', 'observed_at', 'evidence_digest'
    ) OR jsonb_typeof(v_value) <> 'string' THEN
      RETURN false;
    END IF;
  END LOOP;
  IF p_evidence ? 'evidence_digest'
     AND p_evidence->>'evidence_digest' !~ '^[a-f0-9]{64}$' THEN
    RETURN false;
  END IF;
  BEGIN
    PERFORM (p_evidence->>'observed_at')::timestamptz;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
    RETURN false;
  END;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.marketing_brand_report_metadata_is_minimized(
  p_value jsonb
) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, public AS $$
DECLARE
  v_section text;
  v_metric text;
  v_value jsonb;
BEGIN
  IF jsonb_typeof(COALESCE(p_value, 'null'::jsonb)) <> 'object'
     OR p_value - ARRAY[
       'content_quality', 'delivery_receipts', 'audience', 'replies',
       'conversions', 'brand_compliance_exceptions', 'cohort'
     ] <> '{}'::jsonb
     OR NOT (p_value ?& ARRAY[
       'content_quality', 'delivery_receipts', 'audience', 'replies',
       'conversions', 'brand_compliance_exceptions', 'cohort'
     ]) THEN
    RETURN false;
  END IF;
  FOR v_section, v_metric IN SELECT * FROM (VALUES
    ('content_quality', 'accepted'),
    ('delivery_receipts', 'delivered'),
    ('audience', 'observed'),
    ('replies', 'observed'),
    ('conversions', 'observed'),
    ('brand_compliance_exceptions', 'open'),
    ('cohort', 'size')
  ) AS expected(section_name, metric_name)
  LOOP
    v_value := p_value->v_section;
    IF jsonb_typeof(v_value) <> 'object'
       OR NOT (v_value ? v_metric)
       OR v_value - v_metric <> '{}'::jsonb
       OR jsonb_typeof(v_value->v_metric) <> 'number'
       OR v_value->>v_metric !~ '^[0-9]+$' THEN
      RETURN false;
    END IF;
    BEGIN
      IF (v_value->>v_metric)::numeric > 9223372036854775807 THEN
        RETURN false;
      END IF;
    EXCEPTION WHEN numeric_value_out_of_range OR invalid_text_representation THEN
      RETURN false;
    END;
  END LOOP;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.marketing_brand_case_contract_is_minimized(
  p_case_type text,
  p_value jsonb
) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, public AS $$
DECLARE
  v_item jsonb;
BEGIN
  IF jsonb_typeof(COALESCE(p_value, 'null'::jsonb)) <> 'object'
     OR public.marketing_brand_json_has_forbidden_key(p_value) THEN
    RETURN false;
  END IF;
  IF p_case_type = 'goal' THEN
    RETURN p_value ? 'measure'
      AND p_value - 'measure' = '{}'::jsonb
      AND jsonb_typeof(p_value->'measure') = 'string'
      AND p_value->>'measure' ~
        '^[A-Za-z0-9][A-Za-z0-9._:/-]{1,159}$';
  ELSIF p_case_type = 'work' THEN
    IF NOT (p_value ? 'acceptance')
       OR p_value - 'acceptance' <> '{}'::jsonb
       OR jsonb_typeof(p_value->'acceptance') <> 'array'
       OR jsonb_array_length(p_value->'acceptance') NOT BETWEEN 1 AND 20 THEN
      RETURN false;
    END IF;
    FOR v_item IN SELECT value FROM jsonb_array_elements(p_value->'acceptance')
    LOOP
      IF jsonb_typeof(v_item) <> 'string'
         OR v_item #>> '{}' !~
            '^[A-Za-z0-9][A-Za-z0-9._:/-]{1,159}$' THEN
        RETURN false;
      END IF;
    END LOOP;
    RETURN true;
  ELSIF p_case_type = 'decision' THEN
    RETURN p_value ? 'decision_scope'
      AND p_value - 'decision_scope' = '{}'::jsonb
      AND jsonb_typeof(p_value->'decision_scope') = 'string'
      AND p_value->>'decision_scope' ~
        '^[A-Za-z0-9][A-Za-z0-9._:/-]{1,159}$';
  ELSIF p_case_type = 'exception' THEN
    RETURN p_value ? 'resolution'
      AND p_value - 'resolution' = '{}'::jsonb
      AND jsonb_typeof(p_value->'resolution') = 'string'
      AND p_value->>'resolution' ~
        '^[A-Za-z0-9][A-Za-z0-9._:/-]{1,159}$';
  END IF;
  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.marketing_brand_payload_is_minimized(
  p_command text,
  p_payload jsonb
) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, public AS $$
DECLARE
  v_allowed text[];
  v_required text[];
BEGIN
  IF jsonb_typeof(COALESCE(p_payload, 'null'::jsonb)) <> 'object'
     OR public.marketing_brand_json_has_forbidden_key(p_payload) THEN
    RETURN false;
  END IF;
  CASE p_command
    WHEN 'accept_report' THEN
      v_required := ARRAY[
        'report_id', 'reporting_period_start', 'content_version_ids',
        'quality_evaluation_ids', 'delivery_receipt_ids', 'execution_health',
        'content_completion_state', 'brand_compliance_state',
        'brand_compliance_evidence_digest', 'audience_observed_count',
        'reply_observed_count', 'conversion_observed_count', 'cohort_size',
        'structured_report'
      ];
      v_allowed := v_required || ARRAY['metrics_evidence_digest'];
    WHEN 'create_case' THEN
      v_required := ARRAY[
        'report_id', 'case_id', 'case_type', 'title', 'owner_id',
        'sla_due_at', 'contract'
      ];
      v_allowed := v_required;
    WHEN 'accept_work', 'complete_work' THEN
      v_required := ARRAY['case_id']; v_allowed := v_required;
    WHEN 'escalate_work' THEN
      v_required := ARRAY['case_id', 'escalation_code']; v_allowed := v_required;
    WHEN 'record_outcome', 'complete_goal', 'resolve_exception' THEN
      v_required := ARRAY['case_id', 'outcome_state']; v_allowed := v_required;
    WHEN 'decide_decision' THEN
      v_required := ARRAY['case_id', 'decision_result']; v_allowed := v_required;
    ELSE
      RETURN false;
  END CASE;
  RETURN p_payload ?& v_required AND p_payload - v_allowed = '{}'::jsonb;
END;
$$;

CREATE TABLE IF NOT EXISTS public.marketing_brand_head_controls (
  tenant_id                      uuid PRIMARY KEY
                                 REFERENCES public.tenants(id) ON DELETE CASCADE,
  registered_head_id             text NOT NULL
                                 CHECK (char_length(btrim(registered_head_id))
                                   BETWEEN 3 AND 160),
  mission                        text NOT NULL
                                 CHECK (char_length(btrim(mission))
                                   BETWEEN 40 AND 1000),
  kpi_contract                   jsonb NOT NULL CHECK (
    jsonb_typeof(kpi_contract) = 'object'
    AND kpi_contract ?& ARRAY[
      'content_quality_acceptance_rate',
      'delivery_receipt_completeness_rate',
      'audience_evidence_completeness_rate',
      'reply_observation_rate',
      'conversion_observation_rate',
      'brand_compliance_exception_sla_hours',
      'cohort_size_limit'
    ]
  ),
  max_observation_cohort_size    integer NOT NULL DEFAULT 500
                                 CHECK (max_observation_cohort_size BETWEEN 1 AND 100000),
  enabled                        boolean NOT NULL DEFAULT false,
  execution_mode                 text NOT NULL DEFAULT 'disabled'
                                 CHECK (execution_mode IN (
                                   'disabled', 'shadow', 'supervised_read_only'
                                 )),
  kill_switch_engaged            boolean NOT NULL DEFAULT true,
  production_write_authority     boolean NOT NULL DEFAULT false
                                 CHECK (production_write_authority = false),
  content_publication_authority  boolean NOT NULL DEFAULT false
                                 CHECK (content_publication_authority = false),
  provider_dispatch_authority    boolean NOT NULL DEFAULT false
                                 CHECK (provider_dispatch_authority = false),
  customer_contact_authority     boolean NOT NULL DEFAULT false
                                 CHECK (customer_contact_authority = false),
  paid_advertising_authority     boolean NOT NULL DEFAULT false
                                 CHECK (paid_advertising_authority = false),
  spend_authority                boolean NOT NULL DEFAULT false
                                 CHECK (spend_authority = false),
  pricing_authority              boolean NOT NULL DEFAULT false
                                 CHECK (pricing_authority = false),
  legal_policy_authority         boolean NOT NULL DEFAULT false
                                 CHECK (legal_policy_authority = false),
  revision                       bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  activated_by                   uuid,
  activation_evidence            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                     timestamptz NOT NULL DEFAULT now(),
  updated_at                     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.marketing_brand_head_reports (
  id                             uuid PRIMARY KEY,
  tenant_id                      uuid NOT NULL,
  reporting_period_start         date NOT NULL,
  execution_health               text NOT NULL CHECK (
    execution_health IN ('succeeded', 'failed', 'unknown')
  ),
  content_completion_state       text NOT NULL CHECK (
    content_completion_state IN ('completed', 'partial', 'unverified')
  ),
  quality_state                  text NOT NULL CHECK (
    quality_state IN ('accepted', 'rejected', 'unverified')
  ),
  delivery_state                 text NOT NULL CHECK (
    delivery_state IN ('delivered', 'exception', 'unverified')
  ),
  brand_compliance_state         text NOT NULL CHECK (
    brand_compliance_state IN ('verified', 'exception', 'unverified')
  ),
  observation_state              text NOT NULL CHECK (
    observation_state IN ('observed', 'unverified')
  ),
  business_effect_state          text NOT NULL CHECK (
    business_effect_state IN (
      'observed_association', 'not_observed', 'unverified'
    )
  ),
  artifact_version_count         integer NOT NULL CHECK (artifact_version_count > 0),
  quality_evaluation_count       integer NOT NULL CHECK (quality_evaluation_count >= 0),
  accepted_quality_count         integer NOT NULL CHECK (
    accepted_quality_count BETWEEN 0 AND quality_evaluation_count
  ),
  delivery_receipt_count         integer NOT NULL CHECK (delivery_receipt_count >= 0),
  delivered_artifact_count       integer NOT NULL CHECK (
    delivered_artifact_count BETWEEN 0 AND artifact_version_count
  ),
  audience_observed_count        bigint NOT NULL CHECK (audience_observed_count >= 0),
  reply_observed_count           bigint NOT NULL CHECK (
    reply_observed_count BETWEEN 0 AND audience_observed_count
  ),
  conversion_observed_count      bigint NOT NULL CHECK (
    conversion_observed_count BETWEEN 0 AND audience_observed_count
  ),
  cohort_size                    integer NOT NULL CHECK (cohort_size >= 0),
  cohort_limit                   integer NOT NULL CHECK (
    cohort_limit > 0 AND cohort_size <= cohort_limit
  ),
  causal_claim                   boolean NOT NULL DEFAULT false
                                 CHECK (causal_claim = false),
  attribution_model              text NOT NULL DEFAULT 'descriptive_association_only'
                                 CHECK (
                                   attribution_model = 'descriptive_association_only'
                                 ),
  metrics_evidence_digest        text CHECK (
    metrics_evidence_digest IS NULL
    OR metrics_evidence_digest ~ '^[a-f0-9]{64}$'
  ),
  brand_compliance_evidence_digest text NOT NULL CHECK (
    brand_compliance_evidence_digest ~ '^[a-f0-9]{64}$'
  ),
  structured_report              jsonb NOT NULL CHECK (
    public.marketing_brand_report_metadata_is_minimized(structured_report)
  ),
  evidence                       jsonb NOT NULL CHECK (
    public.marketing_brand_evidence_is_minimized(evidence)
  ),
  evidence_digest                text NOT NULL CHECK (
    evidence_digest ~ '^[a-f0-9]{64}$'
  ),
  accepted_by_head_id            text NOT NULL,
  accepted_at                    timestamptz NOT NULL DEFAULT now(),
  idempotency_key                text NOT NULL CHECK (
    char_length(idempotency_key) BETWEEN 8 AND 200
  ),
  request_fingerprint            text NOT NULL CHECK (
    request_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  semantic_fingerprint           text NOT NULL CHECK (
    semantic_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  created_at                     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, reporting_period_start),
  CHECK (reporting_period_start = date_trunc('month', reporting_period_start)::date),
  CHECK (
    observation_state = 'unverified'
    OR (
      metrics_evidence_digest IS NOT NULL
      AND cohort_size > 0
      AND audience_observed_count <= cohort_size
    )
  ),
  CHECK (
    observation_state = 'observed'
    OR (
      metrics_evidence_digest IS NULL
      AND audience_observed_count = 0
      AND reply_observed_count = 0
      AND conversion_observed_count = 0
      AND cohort_size = 0
    )
  ),
  CHECK (
    business_effect_state = 'unverified'
    OR observation_state = 'observed'
  ),
  CHECK (
    business_effect_state <> 'observed_association'
    OR conversion_observed_count > 0
  ),
  CHECK (
    quality_state <> 'accepted'
    OR accepted_quality_count >= artifact_version_count
  ),
  CHECK (
    delivery_state <> 'delivered'
    OR delivered_artifact_count >= artifact_version_count
  )
);

CREATE TABLE IF NOT EXISTS public.marketing_brand_report_artifacts (
  tenant_id                      uuid NOT NULL,
  marketing_brand_report_id      uuid NOT NULL,
  content_version_id             uuid NOT NULL,
  created_at                     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, marketing_brand_report_id, content_version_id),
  FOREIGN KEY (marketing_brand_report_id, tenant_id)
    REFERENCES public.marketing_brand_head_reports(id, tenant_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (content_version_id, tenant_id)
    REFERENCES public.content_artifact_versions(id, tenant_id)
    ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS public.marketing_brand_report_quality (
  tenant_id                      uuid NOT NULL,
  marketing_brand_report_id      uuid NOT NULL,
  quality_evaluation_id          uuid NOT NULL,
  created_at                     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, marketing_brand_report_id, quality_evaluation_id),
  FOREIGN KEY (marketing_brand_report_id, tenant_id)
    REFERENCES public.marketing_brand_head_reports(id, tenant_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (quality_evaluation_id, tenant_id)
    REFERENCES public.content_quality_evaluations(id, tenant_id)
    ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS public.marketing_brand_report_deliveries (
  tenant_id                      uuid NOT NULL,
  marketing_brand_report_id      uuid NOT NULL,
  delivery_receipt_id            uuid NOT NULL,
  created_at                     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, marketing_brand_report_id, delivery_receipt_id),
  FOREIGN KEY (marketing_brand_report_id, tenant_id)
    REFERENCES public.marketing_brand_head_reports(id, tenant_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (delivery_receipt_id, tenant_id)
    REFERENCES public.content_delivery_receipts(id, tenant_id)
    ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS public.marketing_brand_head_cases (
  id                             uuid PRIMARY KEY,
  tenant_id                      uuid NOT NULL,
  source_report_id               uuid NOT NULL,
  case_type                      text NOT NULL CHECK (
    case_type IN ('goal', 'work', 'decision', 'exception')
  ),
  title                          text NOT NULL CHECK (
    char_length(btrim(title)) BETWEEN 3 AND 240
  ),
  lifecycle_state                text NOT NULL CHECK (
    lifecycle_state IN (
      'active', 'assigned', 'accepted', 'escalated', 'completed',
      'pending', 'open', 'resolved'
    )
  ),
  outcome_state                  text NOT NULL DEFAULT 'unknown' CHECK (
    outcome_state IN (
      'unknown', 'verified_achieved', 'verified_not_achieved',
      'not_applicable'
    )
  ),
  decision_result                text NOT NULL DEFAULT 'not_applicable' CHECK (
    decision_result IN ('not_applicable', 'pending', 'approved', 'rejected')
  ),
  revision                       bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  owner_id                       uuid NOT NULL,
  assignee_id                    uuid,
  assignee_actor_id              text,
  contract                       jsonb NOT NULL CHECK (
    public.marketing_brand_case_contract_is_minimized(case_type, contract)
  ),
  assigned_at                    timestamptz,
  accepted_at                    timestamptz,
  sla_due_at                     timestamptz NOT NULL,
  escalated_at                   timestamptz,
  escalation_code                text,
  completed_at                   timestamptz,
  completion_evidence_digest     text,
  outcome_recorded_at            timestamptz,
  outcome_evidence_digest        text,
  created_at                     timestamptz NOT NULL DEFAULT now(),
  updated_at                     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (source_report_id, tenant_id)
    REFERENCES public.marketing_brand_head_reports(id, tenant_id)
    ON DELETE RESTRICT,
  CHECK (
    (
      case_type = 'work'
      AND assignee_id IS NULL
      AND char_length(btrim(assignee_actor_id)) BETWEEN 3 AND 160
      AND assigned_at IS NOT NULL
    )
    OR (
      case_type <> 'work'
      AND assignee_id IS NULL
      AND assignee_actor_id IS NULL
      AND assigned_at IS NULL
    )
  ),
  CHECK (
    (case_type = 'goal' AND lifecycle_state IN ('active', 'completed'))
    OR (
      case_type = 'work'
      AND lifecycle_state IN ('assigned', 'accepted', 'escalated', 'completed')
    )
    OR (
      case_type = 'decision'
      AND lifecycle_state IN ('pending', 'completed')
    )
    OR (
      case_type = 'exception'
      AND lifecycle_state IN ('open', 'resolved')
    )
  ),
  CHECK (
    (
      case_type = 'decision'
      AND decision_result IN ('pending', 'approved', 'rejected')
    )
    OR (
      case_type <> 'decision'
      AND decision_result = 'not_applicable'
    )
  ),
  CHECK (lifecycle_state <> 'accepted' OR accepted_at IS NOT NULL),
  CHECK (
    lifecycle_state <> 'escalated'
    OR (escalated_at IS NOT NULL AND escalation_code IS NOT NULL)
  ),
  CHECK (
    lifecycle_state NOT IN ('completed', 'resolved')
    OR (completed_at IS NOT NULL AND completion_evidence_digest IS NOT NULL)
  ),
  CHECK (
    outcome_state = 'unknown'
    OR (
      case_type = 'decision'
      AND lifecycle_state = 'pending'
      AND outcome_state = 'not_applicable'
    )
    OR (outcome_recorded_at IS NOT NULL AND outcome_evidence_digest IS NOT NULL)
  ),
  CHECK (
    case_type <> 'decision'
    OR outcome_state = 'not_applicable'
  )
);

CREATE TABLE IF NOT EXISTS public.marketing_brand_head_events (
  id                             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                      uuid NOT NULL,
  entity_type                    text NOT NULL CHECK (
    entity_type IN ('report', 'case')
  ),
  entity_id                      uuid NOT NULL,
  command                        text NOT NULL,
  previous_state                 text,
  resulting_state                text NOT NULL,
  expected_revision              bigint NOT NULL CHECK (expected_revision >= 0),
  resulting_revision             bigint NOT NULL CHECK (resulting_revision > 0),
  actor_id                       text NOT NULL,
  authority_tier                 text NOT NULL CHECK (
    authority_tier = 'department_head'
  ),
  evidence                       jsonb NOT NULL CHECK (
    public.marketing_brand_evidence_is_minimized(evidence)
  ),
  evidence_digest                text NOT NULL CHECK (
    evidence_digest ~ '^[a-f0-9]{64}$'
  ),
  request_fingerprint            text NOT NULL CHECK (
    request_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  semantic_fingerprint           text NOT NULL CHECK (
    semantic_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  idempotency_key                text NOT NULL CHECK (
    char_length(idempotency_key) BETWEEN 8 AND 200
  ),
  created_at                     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_marketing_brand_reports_period
  ON public.marketing_brand_head_reports (
    tenant_id, reporting_period_start DESC, delivery_state, quality_state
  );
CREATE INDEX IF NOT EXISTS idx_marketing_brand_cases_open
  ON public.marketing_brand_head_cases (tenant_id, lifecycle_state, sla_due_at);

CREATE OR REPLACE FUNCTION public.marketing_brand_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000', MESSAGE = 'marketing_brand_evidence_is_immutable';
END;
$$;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'marketing_brand_head_reports',
    'marketing_brand_report_artifacts',
    'marketing_brand_report_quality',
    'marketing_brand_report_deliveries',
    'marketing_brand_head_events'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I',
      'trg_' || table_name || '_immutable', table_name);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I ' ||
      'FOR EACH ROW EXECUTE FUNCTION public.marketing_brand_immutable()',
      'trg_' || table_name || '_immutable', table_name
    );
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.marketing_brand_control_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.kill_switch_engaged = true
     AND NEW.kill_switch_engaged = false THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501', MESSAGE = 'marketing_brand_kill_switch_is_one_way';
  END IF;
  IF NEW.production_write_authority OR NEW.content_publication_authority
     OR NEW.provider_dispatch_authority OR NEW.customer_contact_authority
     OR NEW.paid_advertising_authority OR NEW.spend_authority
     OR NEW.pricing_authority OR NEW.legal_policy_authority THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501', MESSAGE = 'marketing_brand_production_authority_forbidden';
  END IF;
  IF NEW.enabled AND (
    NEW.execution_mode NOT IN ('shadow', 'supervised_read_only')
    OR NEW.kill_switch_engaged
    OR NEW.activated_by IS NULL
    OR jsonb_typeof(NEW.activation_evidence) <> 'object'
    OR NEW.activation_evidence = '{}'::jsonb
    OR NOT EXISTS (
      SELECT 1 FROM public.tenant_users tenant_user
       WHERE tenant_user.tenant_id = NEW.tenant_id
         AND tenant_user.user_id = NEW.activated_by
         AND tenant_user.role IN (
           'owner', 'platform_owner', 'founder', 'admin',
           'client_owner', 'tenant_owner'
         )
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501', MESSAGE = 'marketing_brand_activation_invalid';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_marketing_brand_control_guard
  ON public.marketing_brand_head_controls;
CREATE TRIGGER trg_marketing_brand_control_guard
  BEFORE INSERT OR UPDATE ON public.marketing_brand_head_controls
  FOR EACH ROW EXECUTE FUNCTION public.marketing_brand_control_guard();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'marketing_brand_head_controls',
    'marketing_brand_head_reports',
    'marketing_brand_report_artifacts',
    'marketing_brand_report_quality',
    'marketing_brand_report_deliveries',
    'marketing_brand_head_cases',
    'marketing_brand_head_events'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I',
      'tenant_iso_' || table_name, table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (' ||
      'tenant_id = NULLIF(auth.jwt()->''app_metadata''->>''tenant_id'', '''')::uuid ' ||
      'AND auth.jwt()->''app_metadata''->>''role'' IN (' ||
      '''owner'', ''platform_owner'', ''founder'', ''admin'', ' ||
      '''client_owner'', ''tenant_owner'', ''marketing'', ''manager''))',
      'tenant_iso_' || table_name, table_name
    );
  END LOOP;
END $$;

GRANT SELECT ON
  public.marketing_brand_head_controls,
  public.marketing_brand_head_reports,
  public.marketing_brand_report_artifacts,
  public.marketing_brand_report_quality,
  public.marketing_brand_report_deliveries,
  public.marketing_brand_head_cases,
  public.marketing_brand_head_events
TO authenticated, service_role;
REVOKE INSERT, UPDATE, DELETE ON
  public.marketing_brand_head_controls,
  public.marketing_brand_head_reports,
  public.marketing_brand_report_artifacts,
  public.marketing_brand_report_quality,
  public.marketing_brand_report_deliveries,
  public.marketing_brand_head_cases,
  public.marketing_brand_head_events
FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.marketing_brand_head_command_rpc(
  p_tenant_id uuid,
  p_command text,
  p_payload jsonb,
  p_expected_revision bigint,
  p_idempotency_key text,
  p_request_fingerprint text,
  p_actor_id text,
  p_authority_tier text,
  p_evidence jsonb,
  p_feature_gate_enabled boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE
  v_claims text;
  v_role text;
  v_control public.marketing_brand_head_controls%ROWTYPE;
  v_report public.marketing_brand_head_reports%ROWTYPE;
  v_case public.marketing_brand_head_cases%ROWTYPE;
  v_existing public.marketing_brand_head_events%ROWTYPE;
  v_event public.marketing_brand_head_events%ROWTYPE;
  v_evidence_digest text;
  v_semantic text;
  v_report_id uuid;
  v_case_id uuid;
  v_artifact_ids uuid[];
  v_quality_ids uuid[];
  v_delivery_ids uuid[];
  v_artifact_count integer;
  v_quality_count integer;
  v_quality_accepted integer;
  v_quality_rejected integer;
  v_delivery_count integer;
  v_delivered_artifacts integer;
  v_delivery_exceptions integer;
  v_quality_state text;
  v_delivery_state text;
  v_observation_state text;
  v_business_effect text;
  v_audience bigint;
  v_replies bigint;
  v_conversions bigint;
  v_cohort integer;
  v_previous text;
  v_resulting text;
  v_entity_type text;
  v_entity_id uuid;
  v_revision bigint;
  v_case_type text;
BEGIN
  v_claims := NULLIF(current_setting('request.jwt.claims', true), '');
  v_role := COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    CASE WHEN v_claims IS NOT NULL THEN v_claims::jsonb ->> 'role' END,
    session_user::text
  );
  IF v_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'marketing_brand_requires_service_role';
  END IF;
  IF p_feature_gate_enabled IS DISTINCT FROM true THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'marketing_brand_writes_disabled';
  END IF;
  SELECT control.* INTO v_control
    FROM public.marketing_brand_head_controls control
   WHERE control.tenant_id = p_tenant_id
   FOR SHARE;
  IF NOT FOUND OR NOT v_control.enabled OR v_control.kill_switch_engaged
     OR v_control.execution_mode NOT IN ('shadow', 'supervised_read_only') THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'marketing_brand_kill_switch_engaged';
  END IF;
  IF p_actor_id IS DISTINCT FROM v_control.registered_head_id
     OR p_authority_tier IS DISTINCT FROM 'department_head' THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'marketing_brand_registered_head_required';
  END IF;
  IF COALESCE(p_command, '') NOT IN (
    'accept_report', 'create_case', 'accept_work', 'escalate_work',
    'complete_work', 'record_outcome', 'complete_goal',
    'decide_decision', 'resolve_exception'
  ) OR p_expected_revision IS NULL OR p_expected_revision < 0
     OR COALESCE(p_request_fingerprint, '') !~ '^[a-f0-9]{64}$'
     OR char_length(btrim(COALESCE(p_idempotency_key, '')))
        NOT BETWEEN 8 AND 200
     OR NOT public.marketing_brand_payload_is_minimized(p_command, p_payload)
     OR NOT public.marketing_brand_evidence_is_minimized(p_evidence)
     OR (
       p_command = 'accept_report'
       AND NOT public.marketing_brand_report_metadata_is_minimized(
         p_payload->'structured_report'
       )
     )
     OR (
       p_command = 'create_case'
       AND NOT public.marketing_brand_case_contract_is_minimized(
         p_payload->>'case_type', p_payload->'contract'
       )
     ) THEN
    RAISE EXCEPTION 'marketing_brand_command_or_evidence_invalid';
  END IF;
  v_evidence_digest := encode(
    digest(convert_to(p_evidence::text, 'UTF8'), 'sha256'), 'hex'
  );
  v_semantic := encode(digest(convert_to(jsonb_build_object(
    'tenant', p_tenant_id, 'command', p_command, 'payload', p_payload,
    'revision', p_expected_revision, 'actor', p_actor_id,
    'evidence', v_evidence_digest
  )::text, 'UTF8'), 'sha256'), 'hex');
  SELECT event.* INTO v_existing
    FROM public.marketing_brand_head_events event
   WHERE event.tenant_id = p_tenant_id
     AND event.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.request_fingerprint IS DISTINCT FROM p_request_fingerprint
       OR v_existing.semantic_fingerprint IS DISTINCT FROM v_semantic THEN
      RAISE EXCEPTION USING ERRCODE = '23505',
        MESSAGE = 'marketing_brand_idempotency_conflict';
    END IF;
    RETURN jsonb_build_object('outcome', 'replay', 'event', to_jsonb(v_existing));
  END IF;

  IF p_command = 'accept_report' THEN
    BEGIN
      v_report_id := (p_payload->>'report_id')::uuid;
      v_artifact_ids := ARRAY(
        SELECT value::uuid
          FROM jsonb_array_elements_text(p_payload->'content_version_ids')
      );
      v_quality_ids := ARRAY(
        SELECT value::uuid
          FROM jsonb_array_elements_text(
            COALESCE(p_payload->'quality_evaluation_ids', '[]'::jsonb)
          )
      );
      v_delivery_ids := ARRAY(
        SELECT value::uuid
          FROM jsonb_array_elements_text(
            COALESCE(p_payload->'delivery_receipt_ids', '[]'::jsonb)
          )
      );
      v_audience := (p_payload->>'audience_observed_count')::bigint;
      v_replies := (p_payload->>'reply_observed_count')::bigint;
      v_conversions := (p_payload->>'conversion_observed_count')::bigint;
      v_cohort := (p_payload->>'cohort_size')::integer;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'marketing_brand_report_contract_invalid';
    END;
    IF p_expected_revision <> 0 OR v_report_id IS NULL
       OR (p_payload->>'reporting_period_start')::date <>
          date_trunc('month', (p_payload->>'reporting_period_start')::date)::date
       OR p_payload->>'execution_health' NOT IN ('succeeded', 'failed', 'unknown')
       OR p_payload->>'content_completion_state'
          NOT IN ('completed', 'partial', 'unverified')
       OR p_payload->>'brand_compliance_state'
          NOT IN ('verified', 'exception', 'unverified')
       OR p_payload->>'brand_compliance_evidence_digest'
          !~ '^[a-f0-9]{64}$'
       OR jsonb_typeof(p_payload->'structured_report') <> 'object'
       OR p_payload->'structured_report' = '{}'::jsonb
       OR cardinality(v_artifact_ids) < 1
       OR cardinality(v_artifact_ids) <>
          cardinality(ARRAY(SELECT DISTINCT unnest(v_artifact_ids)))
       OR cardinality(v_quality_ids) <>
          cardinality(ARRAY(SELECT DISTINCT unnest(v_quality_ids)))
       OR cardinality(v_delivery_ids) <>
          cardinality(ARRAY(SELECT DISTINCT unnest(v_delivery_ids)))
       OR v_audience < 0 OR v_replies < 0 OR v_conversions < 0 OR v_cohort < 0
       OR v_replies > v_audience OR v_conversions > v_audience
       OR v_cohort > v_control.max_observation_cohort_size THEN
      RAISE EXCEPTION 'marketing_brand_report_contract_invalid';
    END IF;
    v_observation_state := CASE
      WHEN p_payload->>'metrics_evidence_digest' ~ '^[a-f0-9]{64}$'
       AND v_cohort > 0 AND v_audience <= v_cohort
      THEN 'observed' ELSE 'unverified' END;
    IF v_observation_state = 'unverified'
       AND (v_audience <> 0 OR v_replies <> 0 OR v_conversions <> 0
            OR v_cohort <> 0 OR p_payload ? 'metrics_evidence_digest') THEN
      RAISE EXCEPTION 'marketing_brand_observation_evidence_invalid';
    END IF;
    SELECT count(*) INTO v_artifact_count
      FROM public.content_artifact_versions artifact
     WHERE artifact.id = ANY(v_artifact_ids)
       AND artifact.tenant_id = p_tenant_id;
    IF v_artifact_count <> cardinality(v_artifact_ids) THEN
      RAISE EXCEPTION 'marketing_brand_artifact_evidence_mismatch';
    END IF;
    SELECT count(*),
           count(DISTINCT quality.content_version_id) FILTER (
             WHERE quality.quality_state = 'accepted'
           ),
           count(*) FILTER (WHERE quality.quality_state = 'rejected')
      INTO v_quality_count, v_quality_accepted, v_quality_rejected
      FROM public.content_quality_evaluations quality
     WHERE quality.id = ANY(v_quality_ids)
       AND quality.tenant_id = p_tenant_id
       AND quality.content_version_id = ANY(v_artifact_ids);
    IF v_quality_count <> cardinality(v_quality_ids) THEN
      RAISE EXCEPTION 'marketing_brand_quality_evidence_mismatch';
    END IF;
    SELECT count(*),
           count(DISTINCT receipt.content_version_id) FILTER (
             WHERE receipt.delivery_state = 'delivered'
           ),
           count(*) FILTER (
             WHERE receipt.delivery_state IN ('failed', 'stuck', 'exception')
           )
      INTO v_delivery_count, v_delivered_artifacts, v_delivery_exceptions
      FROM public.content_delivery_receipts receipt
     WHERE receipt.id = ANY(v_delivery_ids)
       AND receipt.tenant_id = p_tenant_id
       AND receipt.content_version_id = ANY(v_artifact_ids)
       AND (
         receipt.quality_evaluation_id IS NULL
         OR receipt.quality_evaluation_id = ANY(v_quality_ids)
       );
    IF v_delivery_count <> cardinality(v_delivery_ids) THEN
      RAISE EXCEPTION 'marketing_brand_delivery_evidence_mismatch';
    END IF;
    v_quality_state := CASE
      WHEN v_quality_rejected > 0 THEN 'rejected'
      WHEN v_quality_accepted >= v_artifact_count THEN 'accepted'
      ELSE 'unverified' END;
    v_delivery_state := CASE
      WHEN v_delivery_exceptions > 0 THEN 'exception'
      WHEN v_delivered_artifacts >= v_artifact_count THEN 'delivered'
      ELSE 'unverified' END;
    IF (p_payload#>>'{structured_report,content_quality,accepted}')::bigint
         <> v_quality_accepted
       OR (p_payload#>>'{structured_report,delivery_receipts,delivered}')::bigint
         <> v_delivered_artifacts
       OR (p_payload#>>'{structured_report,audience,observed}')::bigint
         <> v_audience
       OR (p_payload#>>'{structured_report,replies,observed}')::bigint
         <> v_replies
       OR (p_payload#>>'{structured_report,conversions,observed}')::bigint
         <> v_conversions
       OR (p_payload#>>'{structured_report,brand_compliance_exceptions,open}')::bigint
         <> (CASE WHEN p_payload->>'brand_compliance_state' = 'exception'
               THEN 1 ELSE 0 END)
       OR (p_payload#>>'{structured_report,cohort,size}')::bigint <> v_cohort THEN
      RAISE EXCEPTION 'marketing_brand_report_metadata_mismatch';
    END IF;
    v_business_effect := CASE
      WHEN v_observation_state = 'unverified' THEN 'unverified'
      WHEN v_conversions > 0 THEN 'observed_association'
      ELSE 'not_observed' END;
    INSERT INTO public.marketing_brand_head_reports (
      id, tenant_id, reporting_period_start, execution_health,
      content_completion_state, quality_state, delivery_state,
      brand_compliance_state, observation_state, business_effect_state,
      artifact_version_count, quality_evaluation_count,
      accepted_quality_count, delivery_receipt_count,
      delivered_artifact_count, audience_observed_count,
      reply_observed_count, conversion_observed_count, cohort_size,
      cohort_limit, metrics_evidence_digest,
      brand_compliance_evidence_digest, structured_report, evidence,
      evidence_digest, accepted_by_head_id, idempotency_key,
      request_fingerprint, semantic_fingerprint
    ) VALUES (
      v_report_id, p_tenant_id,
      (p_payload->>'reporting_period_start')::date,
      p_payload->>'execution_health',
      p_payload->>'content_completion_state', v_quality_state,
      v_delivery_state, p_payload->>'brand_compliance_state',
      v_observation_state, v_business_effect,
      v_artifact_count, v_quality_count, v_quality_accepted,
      v_delivery_count, v_delivered_artifacts,
      v_audience, v_replies, v_conversions, v_cohort,
      v_control.max_observation_cohort_size,
      NULLIF(p_payload->>'metrics_evidence_digest', ''),
      p_payload->>'brand_compliance_evidence_digest',
      p_payload->'structured_report', p_evidence, v_evidence_digest,
      p_actor_id, p_idempotency_key, p_request_fingerprint, v_semantic
    ) RETURNING * INTO v_report;
    INSERT INTO public.marketing_brand_report_artifacts (
      tenant_id, marketing_brand_report_id, content_version_id
    ) SELECT p_tenant_id, v_report_id, source_id
        FROM unnest(v_artifact_ids) source_id;
    INSERT INTO public.marketing_brand_report_quality (
      tenant_id, marketing_brand_report_id, quality_evaluation_id
    ) SELECT p_tenant_id, v_report_id, source_id
        FROM unnest(v_quality_ids) source_id;
    INSERT INTO public.marketing_brand_report_deliveries (
      tenant_id, marketing_brand_report_id, delivery_receipt_id
    ) SELECT p_tenant_id, v_report_id, source_id
        FROM unnest(v_delivery_ids) source_id;
    v_entity_type := 'report'; v_entity_id := v_report_id;
    v_previous := NULL; v_resulting := v_business_effect; v_revision := 1;
  ELSIF p_command = 'create_case' THEN
    BEGIN
      v_report_id := (p_payload->>'report_id')::uuid;
      v_case_id := (p_payload->>'case_id')::uuid;
      v_case_type := p_payload->>'case_type';
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'marketing_brand_case_contract_invalid';
    END;
    SELECT report.* INTO v_report
      FROM public.marketing_brand_head_reports report
     WHERE report.id = v_report_id AND report.tenant_id = p_tenant_id;
    IF NOT FOUND OR p_expected_revision <> 0 OR v_case_id IS NULL
       OR v_case_type NOT IN ('goal', 'work', 'decision', 'exception')
       OR char_length(btrim(COALESCE(p_payload->>'title', '')))
          NOT BETWEEN 3 AND 240
       OR NULLIF(p_payload->>'owner_id', '')::uuid IS NULL
       OR NULLIF(p_payload->>'sla_due_at', '')::timestamptz IS NULL
       OR NOT public.marketing_brand_case_contract_is_minimized(
         v_case_type, p_payload->'contract'
       )
       OR NOT EXISTS (
         SELECT 1 FROM public.tenant_users tenant_user
          WHERE tenant_user.tenant_id = p_tenant_id
            AND tenant_user.user_id = (p_payload->>'owner_id')::uuid
       ) THEN
      RAISE EXCEPTION 'marketing_brand_case_contract_invalid';
    END IF;
    v_resulting := CASE v_case_type
      WHEN 'goal' THEN 'active' WHEN 'work' THEN 'assigned'
      WHEN 'decision' THEN 'pending' ELSE 'open' END;
    INSERT INTO public.marketing_brand_head_cases (
      id, tenant_id, source_report_id, case_type, title, lifecycle_state,
      owner_id, assignee_id, assignee_actor_id, decision_result,
      outcome_state, contract, assigned_at, sla_due_at
    ) VALUES (
      v_case_id, p_tenant_id, v_report_id, v_case_type,
      p_payload->>'title', v_resulting, (p_payload->>'owner_id')::uuid,
      NULL, CASE WHEN v_case_type = 'work' THEN p_actor_id ELSE NULL END,
      CASE WHEN v_case_type = 'decision' THEN 'pending' ELSE 'not_applicable' END,
      CASE WHEN v_case_type = 'decision' THEN 'not_applicable' ELSE 'unknown' END,
      p_payload->'contract',
      CASE WHEN v_case_type = 'work' THEN now() ELSE NULL END,
      (p_payload->>'sla_due_at')::timestamptz
    ) RETURNING * INTO v_case;
    v_entity_type := 'case'; v_entity_id := v_case_id;
    v_previous := NULL; v_revision := 1;
  ELSE
    BEGIN
      v_case_id := (p_payload->>'case_id')::uuid;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'marketing_brand_case_transition_invalid';
    END;
    SELECT case_row.* INTO v_case
      FROM public.marketing_brand_head_cases case_row
     WHERE case_row.id = v_case_id AND case_row.tenant_id = p_tenant_id
     FOR UPDATE;
    IF NOT FOUND OR v_case.revision <> p_expected_revision THEN
      RAISE EXCEPTION USING ERRCODE = '40001',
        MESSAGE = 'marketing_brand_case_revision_conflict';
    END IF;
    v_previous := v_case.lifecycle_state;
    IF p_command = 'accept_work' THEN
      IF v_case.case_type <> 'work' OR v_case.lifecycle_state <> 'assigned'
         OR v_case.assignee_actor_id IS DISTINCT FROM p_actor_id THEN
        RAISE EXCEPTION 'marketing_brand_work_acceptance_invalid';
      END IF;
      UPDATE public.marketing_brand_head_cases
         SET lifecycle_state = 'accepted', accepted_at = now(),
             revision = revision + 1, updated_at = now()
       WHERE id = v_case_id AND tenant_id = p_tenant_id
      RETURNING * INTO v_case;
    ELSIF p_command = 'escalate_work' THEN
      IF v_case.case_type <> 'work'
         OR v_case.lifecycle_state NOT IN ('assigned', 'accepted')
         OR v_case.assignee_actor_id IS DISTINCT FROM p_actor_id
         OR now() < v_case.sla_due_at
         OR p_payload->>'escalation_code' !~ '^[a-z][a-z0-9_]{2,79}$' THEN
        RAISE EXCEPTION 'marketing_brand_work_escalation_invalid';
      END IF;
      UPDATE public.marketing_brand_head_cases
         SET lifecycle_state = 'escalated', escalated_at = now(),
             escalation_code = p_payload->>'escalation_code',
             revision = revision + 1, updated_at = now()
       WHERE id = v_case_id AND tenant_id = p_tenant_id
      RETURNING * INTO v_case;
    ELSIF p_command = 'complete_work' THEN
      IF v_case.case_type <> 'work'
         OR v_case.lifecycle_state NOT IN ('accepted', 'escalated')
         OR v_case.assignee_actor_id IS DISTINCT FROM p_actor_id THEN
        RAISE EXCEPTION 'marketing_brand_work_completion_invalid';
      END IF;
      UPDATE public.marketing_brand_head_cases
         SET lifecycle_state = 'completed', completed_at = now(),
             completion_evidence_digest = v_evidence_digest,
             revision = revision + 1, updated_at = now()
       WHERE id = v_case_id AND tenant_id = p_tenant_id
      RETURNING * INTO v_case;
    ELSIF p_command = 'record_outcome' THEN
      IF v_case.case_type <> 'work'
         OR v_case.lifecycle_state <> 'completed'
         OR v_case.assignee_actor_id IS DISTINCT FROM p_actor_id
         OR v_case.outcome_state <> 'unknown'
         OR p_payload->>'outcome_state' NOT IN (
           'verified_achieved', 'verified_not_achieved', 'not_applicable'
         ) THEN
        RAISE EXCEPTION 'marketing_brand_outcome_contract_invalid';
      END IF;
      UPDATE public.marketing_brand_head_cases
         SET outcome_state = p_payload->>'outcome_state',
             outcome_recorded_at = now(),
             outcome_evidence_digest = v_evidence_digest,
             revision = revision + 1, updated_at = now()
       WHERE id = v_case_id AND tenant_id = p_tenant_id
      RETURNING * INTO v_case;
    ELSIF p_command = 'complete_goal' THEN
      IF v_case.case_type <> 'goal' OR v_case.lifecycle_state <> 'active'
         OR p_payload->>'outcome_state' NOT IN (
           'verified_achieved', 'verified_not_achieved'
         ) THEN
        RAISE EXCEPTION 'marketing_brand_goal_completion_invalid';
      END IF;
      UPDATE public.marketing_brand_head_cases
         SET lifecycle_state = 'completed', completed_at = now(),
             completion_evidence_digest = v_evidence_digest,
             outcome_state = p_payload->>'outcome_state',
             outcome_recorded_at = now(),
             outcome_evidence_digest = v_evidence_digest,
             revision = revision + 1, updated_at = now()
       WHERE id = v_case_id AND tenant_id = p_tenant_id
      RETURNING * INTO v_case;
    ELSIF p_command = 'decide_decision' THEN
      IF v_case.case_type <> 'decision' OR v_case.lifecycle_state <> 'pending'
         OR p_payload->>'decision_result' NOT IN ('approved', 'rejected') THEN
        RAISE EXCEPTION 'marketing_brand_decision_invalid';
      END IF;
      UPDATE public.marketing_brand_head_cases
         SET lifecycle_state = 'completed', completed_at = now(),
             completion_evidence_digest = v_evidence_digest,
             decision_result = p_payload->>'decision_result',
             outcome_state = 'not_applicable', outcome_recorded_at = now(),
             outcome_evidence_digest = v_evidence_digest,
             revision = revision + 1, updated_at = now()
       WHERE id = v_case_id AND tenant_id = p_tenant_id
      RETURNING * INTO v_case;
    ELSE
      IF v_case.case_type <> 'exception' OR v_case.lifecycle_state <> 'open'
         OR p_payload->>'outcome_state' NOT IN (
           'verified_achieved', 'verified_not_achieved'
         ) THEN
        RAISE EXCEPTION 'marketing_brand_exception_resolution_invalid';
      END IF;
      UPDATE public.marketing_brand_head_cases
         SET lifecycle_state = 'resolved', completed_at = now(),
             completion_evidence_digest = v_evidence_digest,
             outcome_state = p_payload->>'outcome_state',
             outcome_recorded_at = now(),
             outcome_evidence_digest = v_evidence_digest,
             revision = revision + 1, updated_at = now()
       WHERE id = v_case_id AND tenant_id = p_tenant_id
      RETURNING * INTO v_case;
    END IF;
    v_entity_type := 'case'; v_entity_id := v_case_id;
    v_resulting := CASE
      WHEN p_command IN ('record_outcome', 'complete_goal', 'resolve_exception')
        THEN v_case.outcome_state
      WHEN p_command = 'decide_decision' THEN v_case.decision_result
      ELSE v_case.lifecycle_state
    END;
    v_revision := v_case.revision;
  END IF;

  INSERT INTO public.marketing_brand_head_events (
    tenant_id, entity_type, entity_id, command, previous_state,
    resulting_state, expected_revision, resulting_revision, actor_id,
    authority_tier, evidence, evidence_digest, request_fingerprint,
    semantic_fingerprint, idempotency_key
  ) VALUES (
    p_tenant_id, v_entity_type, v_entity_id, p_command, v_previous,
    v_resulting, p_expected_revision, v_revision, p_actor_id,
    p_authority_tier, p_evidence, v_evidence_digest, p_request_fingerprint,
    v_semantic, p_idempotency_key
  ) RETURNING * INTO v_event;
  RETURN jsonb_build_object(
    'outcome', 'applied', 'entity_type', v_entity_type,
    'entity_id', v_entity_id, 'state', v_resulting,
    'revision', v_revision, 'event_id', v_event.id,
    'execution_health', CASE WHEN v_entity_type = 'report'
      THEN v_report.execution_health ELSE NULL END,
    'content_completion_state', CASE WHEN v_entity_type = 'report'
      THEN v_report.content_completion_state ELSE NULL END,
    'quality_state', CASE WHEN v_entity_type = 'report'
      THEN v_report.quality_state ELSE NULL END,
    'delivery_state', CASE WHEN v_entity_type = 'report'
      THEN v_report.delivery_state ELSE NULL END,
    'business_effect_state', CASE WHEN v_entity_type = 'report'
      THEN v_report.business_effect_state ELSE NULL END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.marketing_brand_head_command_rpc(
  uuid, text, jsonb, bigint, text, text, text, text, jsonb, boolean
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.marketing_brand_head_command_rpc(
  uuid, text, jsonb, bigint, text, text, text, text, jsonb, boolean
) TO service_role;

CREATE OR REPLACE FUNCTION public.marketing_brand_head_kill_switch_rpc(
  p_tenant_id uuid, p_reason text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE
  v_role text;
  v_digest text;
  v_revision bigint;
BEGIN
  v_role := COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    session_user::text
  );
  IF v_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'marketing_brand_requires_service_role';
  END IF;
  IF p_tenant_id IS NULL
     OR char_length(btrim(COALESCE(p_reason, ''))) NOT BETWEEN 8 AND 240 THEN
    RAISE EXCEPTION 'marketing_brand_kill_reason_required';
  END IF;
  v_digest := encode(digest(convert_to(p_reason, 'UTF8'), 'sha256'), 'hex');
  UPDATE public.marketing_brand_head_controls
     SET enabled = false, execution_mode = 'disabled',
         kill_switch_engaged = true, revision = revision + 1,
         activation_evidence =
           (activation_evidence - 'kill_switch_reason')
           || jsonb_build_object(
             'kill_switch_reason_digest', v_digest,
             'kill_switch_engaged_at', now()
           ),
         updated_at = now()
   WHERE tenant_id = p_tenant_id
  RETURNING revision INTO v_revision;
  IF NOT FOUND THEN RAISE EXCEPTION 'marketing_brand_control_not_found'; END IF;
  RETURN jsonb_build_object(
    'outcome', 'contained', 'tenant_id', p_tenant_id,
    'revision', v_revision, 'reason_digest', v_digest
  );
END;
$$;

REVOKE ALL ON FUNCTION
  public.marketing_brand_head_kill_switch_rpc(uuid, text)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.marketing_brand_head_kill_switch_rpc(uuid, text)
TO service_role;
