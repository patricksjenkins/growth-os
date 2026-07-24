-- ============================================================================
-- Migration 090: Supervised Finance & Data Governance Department Head
-- Date: 2026-07-24
--
-- Additive evidence-only executive control over canonical attribution (079)
-- and monthly close (081). It does not mutate either source. Successful agent
-- execution is stored separately and can never imply reconciled finance truth.
--
-- ROLLBACK:
-- db/rollbacks/090_finance_data_governance_head_supervised_rollback.sql
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.finance_governance_head_controls (
  tenant_id                         uuid PRIMARY KEY
                                    REFERENCES public.tenants(id) ON DELETE CASCADE,
  registered_head_id                text NOT NULL
                                    CHECK (char_length(btrim(registered_head_id))
                                      BETWEEN 3 AND 160),
  mission                           text NOT NULL
                                    CHECK (char_length(btrim(mission))
                                      BETWEEN 40 AND 1000),
  kpi_contract                      jsonb NOT NULL CHECK (
    jsonb_typeof(kpi_contract) = 'object'
    AND kpi_contract ?& ARRAY[
      'reconciliation_match_rate',
      'monthly_close_sla_days',
      'exception_resolution_sla_hours',
      'data_quality_pass_rate',
      'evidence_completeness_rate',
      'tenant_isolation_gate_pass_rate'
    ]
  ),
  enabled                           boolean NOT NULL DEFAULT false,
  execution_mode                    text NOT NULL DEFAULT 'disabled'
                                    CHECK (execution_mode IN (
                                      'disabled', 'shadow',
                                      'supervised_read_only'
                                    )),
  kill_switch_engaged               boolean NOT NULL DEFAULT true,
  production_write_authority        boolean NOT NULL DEFAULT false
                                    CHECK (production_write_authority = false),
  money_movement_authority          boolean NOT NULL DEFAULT false
                                    CHECK (money_movement_authority = false),
  charge_refund_authority           boolean NOT NULL DEFAULT false
                                    CHECK (charge_refund_authority = false),
  provider_dispatch_authority       boolean NOT NULL DEFAULT false
                                    CHECK (provider_dispatch_authority = false),
  pricing_authority                 boolean NOT NULL DEFAULT false
                                    CHECK (pricing_authority = false),
  period_lock_authority             boolean NOT NULL DEFAULT false
                                    CHECK (period_lock_authority = false),
  export_authority                  boolean NOT NULL DEFAULT false
                                    CHECK (export_authority = false),
  customer_communication_authority  boolean NOT NULL DEFAULT false
                                    CHECK (customer_communication_authority = false),
  revision                          bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  activated_by                      uuid,
  activation_evidence               jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                        timestamptz NOT NULL DEFAULT now(),
  updated_at                        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.finance_governance_head_reports (
  id                                uuid PRIMARY KEY,
  tenant_id                         uuid NOT NULL,
  finance_close_cycle_id            uuid NOT NULL,
  period_start                      date NOT NULL,
  currency                          text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  execution_health                  text NOT NULL CHECK (
    execution_health IN ('succeeded', 'failed', 'unknown')
  ),
  reconciliation_state              text NOT NULL CHECK (
    reconciliation_state IN ('matched', 'exception', 'unverified')
  ),
  monthly_close_state               text NOT NULL,
  data_governance_state             text NOT NULL CHECK (
    data_governance_state IN ('verified', 'exception', 'unverified')
  ),
  financial_truth_state             text NOT NULL CHECK (
    financial_truth_state IN ('verified', 'exception', 'unverified')
  ),
  attribution_record_count          integer NOT NULL CHECK (
    attribution_record_count > 0
  ),
  revenue_minor                     bigint NOT NULL,
  cost_minor                        bigint NOT NULL,
  margin_minor                      bigint NOT NULL,
  structured_report                 jsonb NOT NULL CHECK (
    jsonb_typeof(structured_report) = 'object'
    AND structured_report <> '{}'::jsonb
  ),
  governance_evidence_digest        text NOT NULL CHECK (
    governance_evidence_digest ~ '^[a-f0-9]{64}$'
  ),
  evidence                          jsonb NOT NULL,
  evidence_digest                   text NOT NULL CHECK (
    evidence_digest ~ '^[a-f0-9]{64}$'
  ),
  accepted_by_head_id               text NOT NULL,
  accepted_at                       timestamptz NOT NULL DEFAULT now(),
  idempotency_key                   text NOT NULL CHECK (
    char_length(idempotency_key) BETWEEN 8 AND 200
  ),
  request_fingerprint               text NOT NULL CHECK (
    request_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  semantic_fingerprint              text NOT NULL CHECK (
    semantic_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  created_at                        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, period_start, currency),
  FOREIGN KEY (finance_close_cycle_id, tenant_id)
    REFERENCES public.finance_close_cycles(id, tenant_id) ON DELETE RESTRICT,
  CHECK (period_start = date_trunc('month', period_start)::date),
  CHECK (margin_minor = revenue_minor - cost_minor),
  CHECK (
    financial_truth_state <> 'verified'
    OR (
      reconciliation_state = 'matched'
      AND monthly_close_state = 'shadow_locked'
      AND data_governance_state = 'verified'
    )
  )
);

CREATE TABLE IF NOT EXISTS public.finance_governance_report_attributions (
  tenant_id                         uuid NOT NULL,
  finance_governance_report_id      uuid NOT NULL,
  finance_attribution_record_id     uuid NOT NULL,
  created_at                        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (
    tenant_id, finance_governance_report_id, finance_attribution_record_id
  ),
  FOREIGN KEY (finance_governance_report_id, tenant_id)
    REFERENCES public.finance_governance_head_reports(id, tenant_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (finance_attribution_record_id, tenant_id)
    REFERENCES public.finance_attribution_records(id, tenant_id)
    ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS public.finance_governance_head_cases (
  id                                uuid PRIMARY KEY,
  tenant_id                         uuid NOT NULL,
  source_report_id                  uuid NOT NULL,
  case_type                         text NOT NULL CHECK (
    case_type IN ('goal', 'work', 'decision', 'exception')
  ),
  title                             text NOT NULL CHECK (
    char_length(btrim(title)) BETWEEN 3 AND 240
  ),
  lifecycle_state                   text NOT NULL CHECK (
    lifecycle_state IN (
      'active', 'assigned', 'accepted', 'escalated', 'completed',
      'pending', 'open', 'resolved'
    )
  ),
  outcome_state                     text NOT NULL DEFAULT 'unknown' CHECK (
    outcome_state IN (
      'unknown', 'verified_achieved', 'verified_not_achieved',
      'not_applicable'
    )
  ),
  decision_result                   text NOT NULL DEFAULT 'not_applicable' CHECK (
    decision_result IN ('not_applicable', 'pending', 'approved', 'rejected')
  ),
  revision                          bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  owner_id                          uuid NOT NULL,
  assignee_id                       uuid,
  assignee_actor_id                 text,
  contract                          jsonb NOT NULL CHECK (
    jsonb_typeof(contract) = 'object' AND contract <> '{}'::jsonb
  ),
  assigned_at                       timestamptz,
  accepted_at                       timestamptz,
  sla_due_at                        timestamptz NOT NULL,
  escalated_at                      timestamptz,
  escalation_code                   text,
  completed_at                      timestamptz,
  completion_evidence_digest        text,
  outcome_recorded_at               timestamptz,
  outcome_evidence_digest           text,
  created_at                        timestamptz NOT NULL DEFAULT now(),
  updated_at                        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (source_report_id, tenant_id)
    REFERENCES public.finance_governance_head_reports(id, tenant_id)
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
    (case_type = 'decision' AND decision_result IN (
      'pending', 'approved', 'rejected'
    ))
    OR (case_type <> 'decision' AND decision_result = 'not_applicable')
  ),
  CHECK (
    lifecycle_state <> 'accepted' OR accepted_at IS NOT NULL
  ),
  CHECK (
    lifecycle_state <> 'escalated'
    OR (escalated_at IS NOT NULL AND escalation_code IS NOT NULL)
  ),
  CHECK (
    lifecycle_state <> 'completed'
    OR (completed_at IS NOT NULL AND completion_evidence_digest IS NOT NULL)
  ),
  CHECK (
    lifecycle_state <> 'resolved'
    OR (
      case_type = 'exception'
      AND completed_at IS NOT NULL
      AND completion_evidence_digest IS NOT NULL
    )
  ),
  CHECK (
    outcome_state = 'unknown'
    OR (outcome_recorded_at IS NOT NULL AND outcome_evidence_digest IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS public.finance_governance_head_events (
  id                                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                         uuid NOT NULL,
  entity_type                       text NOT NULL CHECK (
    entity_type IN ('report', 'case')
  ),
  entity_id                         uuid NOT NULL,
  command                           text NOT NULL,
  previous_state                    text,
  resulting_state                   text NOT NULL,
  expected_revision                 bigint NOT NULL CHECK (expected_revision >= 0),
  resulting_revision                bigint NOT NULL CHECK (resulting_revision > 0),
  actor_id                          text NOT NULL,
  authority_tier                    text NOT NULL CHECK (
    authority_tier = 'department_head'
  ),
  evidence                          jsonb NOT NULL,
  evidence_digest                   text NOT NULL CHECK (
    evidence_digest ~ '^[a-f0-9]{64}$'
  ),
  request_fingerprint               text NOT NULL CHECK (
    request_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  semantic_fingerprint              text NOT NULL CHECK (
    semantic_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  idempotency_key                   text NOT NULL CHECK (
    char_length(idempotency_key) BETWEEN 8 AND 200
  ),
  created_at                        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_finance_governance_reports_period
  ON public.finance_governance_head_reports
    (tenant_id, period_start DESC, currency, financial_truth_state);
CREATE INDEX IF NOT EXISTS idx_finance_governance_cases_open
  ON public.finance_governance_head_cases
    (tenant_id, lifecycle_state, sla_due_at);

CREATE OR REPLACE FUNCTION public.finance_governance_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000', MESSAGE = 'finance_governance_evidence_is_immutable';
END;
$$;

CREATE OR REPLACE FUNCTION public.finance_governance_json_has_forbidden_key(
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
        'charge', 'refund', 'transfer', 'moneymovement',
        'providerdispatch', 'pricingchange', 'periodlock', 'export',
        'productionwrite', 'send', 'publish', 'customeremail',
        'customerphone', 'providertoken', 'revenueminor', 'costminor',
        'marginminor', 'financialtruthstate', 'reconciliationstate',
        'monthlyclosestate', 'authorization', 'apikey', 'accesstoken',
        'refreshtoken', 'password', 'secret', 'credential', 'cookie',
        'setcookie', 'privatekey', 'clientsecret'
      ]) THEN
        RETURN true;
      END IF;
      IF public.finance_governance_json_has_forbidden_key(v_child) THEN
        RETURN true;
      END IF;
    END LOOP;
  ELSIF jsonb_typeof(p_value) = 'array' THEN
    FOR v_child IN SELECT value FROM jsonb_array_elements(p_value) LOOP
      IF public.finance_governance_json_has_forbidden_key(v_child) THEN
        RETURN true;
      END IF;
    END LOOP;
  END IF;
  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.finance_governance_evidence_is_minimized(
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
     OR public.finance_governance_json_has_forbidden_key(p_evidence)
     OR NOT (p_evidence ?& ARRAY[
       'source_type', 'source_id', 'observed_at'
     ])
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

CREATE OR REPLACE FUNCTION
public.finance_governance_report_metadata_is_minimized(p_value jsonb)
RETURNS boolean
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, public AS $$
BEGIN
  IF jsonb_typeof(COALESCE(p_value, 'null'::jsonb)) <> 'object'
     OR NOT (p_value ?& ARRAY['controls_tested', 'exceptions'])
     OR p_value - ARRAY['controls_tested', 'exceptions'] <> '{}'::jsonb
     OR jsonb_typeof(p_value->'controls_tested') <> 'number'
     OR jsonb_typeof(p_value->'exceptions') <> 'number'
     OR p_value->>'controls_tested' !~ '^[0-9]+$'
     OR p_value->>'exceptions' !~ '^[0-9]+$' THEN
    RETURN false;
  END IF;
  BEGIN
    RETURN (p_value->>'controls_tested')::numeric <= 2147483647
      AND (p_value->>'exceptions')::numeric <= 2147483647;
  EXCEPTION WHEN numeric_value_out_of_range OR invalid_text_representation THEN
    RETURN false;
  END;
END;
$$;

CREATE OR REPLACE FUNCTION
public.finance_governance_case_contract_is_minimized(
  p_case_type text,
  p_value jsonb
) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, public AS $$
DECLARE
  v_item jsonb;
BEGIN
  IF jsonb_typeof(COALESCE(p_value, 'null'::jsonb)) <> 'object' THEN
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
       OR jsonb_typeof(p_value->'acceptance') <> 'array' THEN
      RETURN false;
    END IF;
    IF jsonb_array_length(p_value->'acceptance') NOT BETWEEN 1 AND 20 THEN
      RETURN false;
    END IF;
    FOR v_item IN SELECT value
      FROM jsonb_array_elements(p_value->'acceptance')
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

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'finance_governance_head_reports',
    'finance_governance_report_attributions',
    'finance_governance_head_events'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I',
      'trg_' || table_name || '_immutable', table_name);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I ' ||
      'FOR EACH ROW EXECUTE FUNCTION public.finance_governance_immutable()',
      'trg_' || table_name || '_immutable', table_name
    );
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.finance_governance_control_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.kill_switch_engaged = true
     AND NEW.kill_switch_engaged = false THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501', MESSAGE = 'finance_governance_kill_switch_is_one_way';
  END IF;
  IF NEW.production_write_authority OR NEW.money_movement_authority
     OR NEW.charge_refund_authority OR NEW.provider_dispatch_authority
     OR NEW.pricing_authority OR NEW.period_lock_authority
     OR NEW.export_authority OR NEW.customer_communication_authority THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501', MESSAGE = 'finance_governance_production_authority_forbidden';
  END IF;
  IF NEW.enabled AND (
    NEW.execution_mode NOT IN ('shadow', 'supervised_read_only')
    OR NEW.kill_switch_engaged
    OR NEW.activated_by IS NULL
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
      ERRCODE = '42501', MESSAGE = 'finance_governance_activation_invalid';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_finance_governance_control_guard
  ON public.finance_governance_head_controls;
CREATE TRIGGER trg_finance_governance_control_guard
  BEFORE INSERT OR UPDATE ON public.finance_governance_head_controls
  FOR EACH ROW EXECUTE FUNCTION public.finance_governance_control_guard();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'finance_governance_head_controls',
    'finance_governance_head_reports',
    'finance_governance_report_attributions',
    'finance_governance_head_cases',
    'finance_governance_head_events'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I',
      'tenant_iso_' || table_name, table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (' ||
      'tenant_id = NULLIF(auth.jwt()->''app_metadata''->>''tenant_id'', '''')::uuid ' ||
      'AND auth.jwt()->''app_metadata''->>''role'' IN (' ||
      '''owner'', ''platform_owner'', ''founder'', ''admin'', ' ||
      '''client_owner'', ''tenant_owner'', ''finance'', ''manager''))',
      'tenant_iso_' || table_name, table_name
    );
  END LOOP;
END $$;

GRANT SELECT ON
  public.finance_governance_head_controls,
  public.finance_governance_head_reports,
  public.finance_governance_report_attributions,
  public.finance_governance_head_cases,
  public.finance_governance_head_events
TO authenticated, service_role;
REVOKE INSERT, UPDATE, DELETE ON
  public.finance_governance_head_controls,
  public.finance_governance_head_reports,
  public.finance_governance_report_attributions,
  public.finance_governance_head_cases,
  public.finance_governance_head_events
FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION
  public.finance_governance_json_has_forbidden_key(jsonb)
FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION
  public.finance_governance_evidence_is_minimized(jsonb)
FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION
  public.finance_governance_report_metadata_is_minimized(jsonb)
FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION
  public.finance_governance_case_contract_is_minimized(text, jsonb)
FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.finance_governance_head_command_rpc(
  p_tenant_id uuid,
  p_command text,
  p_report_id uuid,
  p_case_id uuid,
  p_finance_close_cycle_id uuid,
  p_period_start date,
  p_currency text,
  p_attribution_record_ids uuid[],
  p_execution_health text,
  p_data_governance_state text,
  p_governance_evidence_digest text,
  p_structured_report jsonb,
  p_case_type text,
  p_title text,
  p_owner_id uuid,
  p_assignee_id uuid,
  p_sla_due_at timestamptz,
  p_contract jsonb,
  p_escalation_code text,
  p_outcome_state text,
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
  v_control public.finance_governance_head_controls%ROWTYPE;
  v_report public.finance_governance_head_reports%ROWTYPE;
  v_case public.finance_governance_head_cases%ROWTYPE;
  v_existing public.finance_governance_head_events%ROWTYPE;
  v_event public.finance_governance_head_events%ROWTYPE;
  v_close public.finance_close_cycles%ROWTYPE;
  v_evidence_digest text;
  v_semantic text;
  v_count integer;
  v_bad integer;
  v_scope_count integer;
  v_missing integer;
  v_manifest_complete boolean;
  v_revenue bigint;
  v_cost bigint;
  v_truth text;
  v_previous text;
  v_resulting text;
  v_entity_type text;
  v_entity_id uuid;
  v_revision bigint;
BEGIN
  v_claims := NULLIF(current_setting('request.jwt.claims', true), '');
  v_role := COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    CASE WHEN v_claims IS NOT NULL THEN v_claims::jsonb ->> 'role' END,
    session_user::text
  );
  IF v_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'finance_governance_requires_service_role';
  END IF;
  IF p_feature_gate_enabled IS DISTINCT FROM true THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'finance_governance_writes_disabled';
  END IF;
  SELECT control.* INTO v_control
    FROM public.finance_governance_head_controls control
   WHERE control.tenant_id = p_tenant_id
   FOR SHARE;
  IF NOT FOUND OR NOT v_control.enabled OR v_control.kill_switch_engaged
     OR v_control.execution_mode NOT IN ('shadow', 'supervised_read_only') THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'finance_governance_kill_switch_engaged';
  END IF;
  IF p_actor_id IS DISTINCT FROM v_control.registered_head_id
     OR p_authority_tier IS DISTINCT FROM 'department_head' THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'finance_governance_registered_head_required';
  END IF;
  IF COALESCE(p_command, '') NOT IN (
    'accept_report', 'create_case', 'accept_work', 'escalate_work',
    'complete_work', 'record_outcome', 'complete_goal',
    'decide_decision', 'resolve_exception'
  ) OR p_expected_revision IS NULL OR p_expected_revision < 0
     OR COALESCE(p_request_fingerprint, '') !~ '^[a-f0-9]{64}$'
     OR char_length(btrim(COALESCE(p_idempotency_key, '')))
        NOT BETWEEN 8 AND 200
     OR NOT public.finance_governance_evidence_is_minimized(p_evidence)
     OR public.finance_governance_json_has_forbidden_key(
       COALESCE(p_structured_report, '{}'::jsonb)
     )
     OR public.finance_governance_json_has_forbidden_key(
       COALESCE(p_contract, '{}'::jsonb)
     )
     OR (
       p_command = 'accept_report'
       AND NOT public.finance_governance_report_metadata_is_minimized(
         p_structured_report
       )
     )
     OR (
       p_command = 'create_case'
       AND NOT public.finance_governance_case_contract_is_minimized(
         p_case_type, p_contract
       )
     )
     OR (
       p_command NOT IN ('accept_report', 'create_case')
       AND (
         COALESCE(p_structured_report, '{}'::jsonb) <> '{}'::jsonb
         OR COALESCE(p_contract, '{}'::jsonb) <> '{}'::jsonb
       )
     ) THEN
    RAISE EXCEPTION 'finance_governance_command_or_evidence_invalid';
  END IF;
  v_evidence_digest := encode(
    digest(convert_to(p_evidence::text, 'UTF8'), 'sha256'), 'hex'
  );
  v_semantic := encode(digest(convert_to(jsonb_build_object(
    'tenant', p_tenant_id, 'command', p_command, 'report', p_report_id,
    'case', p_case_id, 'close', p_finance_close_cycle_id,
    'period', p_period_start, 'currency', p_currency,
    'records', p_attribution_record_ids, 'execution', p_execution_health,
    'governance', p_data_governance_state,
    'governance_digest', p_governance_evidence_digest,
    'structured', p_structured_report, 'case_type', p_case_type,
    'title', p_title, 'owner', p_owner_id, 'assignee', p_assignee_id,
    'sla', p_sla_due_at, 'contract', p_contract,
    'escalation', p_escalation_code, 'outcome', p_outcome_state,
    'revision', p_expected_revision, 'actor', p_actor_id,
    'evidence', v_evidence_digest
  )::text, 'UTF8'), 'sha256'), 'hex');
  SELECT event.* INTO v_existing
    FROM public.finance_governance_head_events event
   WHERE event.tenant_id = p_tenant_id
     AND event.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.request_fingerprint IS DISTINCT FROM p_request_fingerprint
       OR v_existing.semantic_fingerprint IS DISTINCT FROM v_semantic THEN
      RAISE EXCEPTION USING ERRCODE = '23505',
        MESSAGE = 'finance_governance_idempotency_conflict';
    END IF;
    RETURN jsonb_build_object('outcome', 'replay', 'event', to_jsonb(v_existing));
  END IF;

  IF p_command = 'accept_report' THEN
    IF p_expected_revision <> 0 OR p_report_id IS NULL
       OR p_period_start <> date_trunc('month', p_period_start)::date
       OR p_currency !~ '^[A-Z]{3}$'
       OR cardinality(p_attribution_record_ids) < 1
       OR p_execution_health NOT IN ('succeeded', 'failed', 'unknown')
       OR p_data_governance_state NOT IN (
         'verified', 'exception', 'unverified'
       )
       OR p_governance_evidence_digest !~ '^[a-f0-9]{64}$'
       OR NOT public.finance_governance_report_metadata_is_minimized(
         p_structured_report
       ) THEN
      RAISE EXCEPTION 'finance_governance_report_contract_invalid';
    END IF;
    IF cardinality(p_attribution_record_ids)
       <> cardinality(ARRAY(SELECT DISTINCT unnest(p_attribution_record_ids))) THEN
      RAISE EXCEPTION 'finance_governance_duplicate_attribution_evidence';
    END IF;
    SELECT cycle.* INTO v_close FROM public.finance_close_cycles cycle
     WHERE cycle.id = p_finance_close_cycle_id
       AND cycle.tenant_id = p_tenant_id
       AND cycle.period_start = p_period_start
       AND cycle.currency = p_currency;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'finance_governance_close_cycle_not_found';
    END IF;
    SELECT count(*),
           count(*) FILTER (
             WHERE NOT (attribution.id = ANY(p_attribution_record_ids))
           )
      INTO v_scope_count, v_missing
      FROM public.finance_attribution_records attribution
     WHERE attribution.tenant_id = p_tenant_id
       AND attribution.currency = p_currency
       AND attribution.occurred_on >= p_period_start
       AND attribution.occurred_on <
         (p_period_start + interval '1 month')::date;
    v_manifest_complete :=
      v_close.reconciliation_manifest_digest IS NOT NULL
      AND v_close.reconciliation_record_count =
        cardinality(p_attribution_record_ids)
      AND v_scope_count = v_close.reconciliation_record_count
      AND v_missing = 0;
    IF NOT v_manifest_complete THEN
      RAISE EXCEPTION 'finance_governance_attribution_manifest_incomplete';
    END IF;
    SELECT count(*),
           count(*) FILTER (
             WHERE attribution.reconciliation_status <> 'matched'
           ),
           COALESCE(sum(attribution.revenue_minor), 0),
           COALESCE(sum(attribution.cost_minor), 0)
      INTO v_count, v_bad, v_revenue, v_cost
      FROM public.finance_attribution_records attribution
     WHERE attribution.id = ANY(p_attribution_record_ids)
       AND attribution.tenant_id = p_tenant_id
       AND attribution.currency = p_currency
       AND attribution.occurred_on >= p_period_start
       AND attribution.occurred_on <
         (p_period_start + interval '1 month')::date;
    IF v_count <> cardinality(p_attribution_record_ids) THEN
      RAISE EXCEPTION 'finance_governance_attribution_evidence_mismatch';
    END IF;
    v_truth := CASE
      WHEN v_bad = 0
       AND v_manifest_complete
       AND v_close.close_state = 'shadow_locked'
       AND p_data_governance_state = 'verified'
      THEN 'verified'
      WHEN v_bad > 0 OR p_data_governance_state = 'exception'
      THEN 'exception'
      ELSE 'unverified'
    END;
    INSERT INTO public.finance_governance_head_reports (
      id, tenant_id, finance_close_cycle_id, period_start, currency,
      execution_health, reconciliation_state, monthly_close_state,
      data_governance_state, financial_truth_state,
      attribution_record_count, revenue_minor, cost_minor, margin_minor,
      structured_report, governance_evidence_digest, evidence,
      evidence_digest, accepted_by_head_id, idempotency_key,
      request_fingerprint, semantic_fingerprint
    ) VALUES (
      p_report_id, p_tenant_id, p_finance_close_cycle_id,
      p_period_start, p_currency, p_execution_health,
      CASE WHEN v_bad = 0 THEN 'matched' ELSE 'exception' END,
      v_close.close_state, p_data_governance_state, v_truth,
      v_count, v_revenue, v_cost, v_revenue - v_cost,
      p_structured_report, p_governance_evidence_digest, p_evidence,
      v_evidence_digest, p_actor_id, p_idempotency_key,
      p_request_fingerprint, v_semantic
    ) RETURNING * INTO v_report;
    INSERT INTO public.finance_governance_report_attributions (
      tenant_id, finance_governance_report_id, finance_attribution_record_id
    ) SELECT p_tenant_id, p_report_id, record_id
        FROM unnest(p_attribution_record_ids) record_id;
    v_entity_type := 'report'; v_entity_id := p_report_id;
    v_previous := NULL; v_resulting := v_truth; v_revision := 1;
  ELSIF p_command = 'create_case' THEN
    SELECT report.* INTO v_report
      FROM public.finance_governance_head_reports report
     WHERE report.id = p_report_id AND report.tenant_id = p_tenant_id;
    IF NOT FOUND OR p_expected_revision <> 0 OR p_case_id IS NULL
       OR p_case_type NOT IN ('goal', 'work', 'decision', 'exception')
       OR char_length(btrim(COALESCE(p_title, ''))) NOT BETWEEN 3 AND 240
       OR p_owner_id IS NULL OR p_sla_due_at IS NULL
       OR NOT public.finance_governance_case_contract_is_minimized(
         p_case_type, p_contract
       )
       OR p_assignee_id IS NOT NULL
       OR NOT EXISTS (
         SELECT 1 FROM public.tenant_users tenant_user
          WHERE tenant_user.tenant_id = p_tenant_id
            AND tenant_user.user_id = p_owner_id
       ) THEN
      RAISE EXCEPTION 'finance_governance_case_contract_invalid';
    END IF;
    v_resulting := CASE p_case_type
      WHEN 'goal' THEN 'active' WHEN 'work' THEN 'assigned'
      WHEN 'decision' THEN 'pending' ELSE 'open' END;
    INSERT INTO public.finance_governance_head_cases (
      id, tenant_id, source_report_id, case_type, title, lifecycle_state,
      owner_id, assignee_id, assignee_actor_id, decision_result,
      contract, assigned_at, sla_due_at
    ) VALUES (
      p_case_id, p_tenant_id, p_report_id, p_case_type, p_title, v_resulting,
      p_owner_id, NULL,
      CASE WHEN p_case_type = 'work' THEN p_actor_id ELSE NULL END,
      CASE WHEN p_case_type = 'decision' THEN 'pending' ELSE 'not_applicable' END,
      p_contract,
      CASE WHEN p_case_type = 'work' THEN now() ELSE NULL END, p_sla_due_at
    ) RETURNING * INTO v_case;
    v_entity_type := 'case'; v_entity_id := p_case_id;
    v_previous := NULL; v_revision := 1;
  ELSE
    SELECT case_row.* INTO v_case
      FROM public.finance_governance_head_cases case_row
     WHERE case_row.id = p_case_id AND case_row.tenant_id = p_tenant_id
     FOR UPDATE;
    IF NOT FOUND OR v_case.revision <> p_expected_revision THEN
      RAISE EXCEPTION USING ERRCODE = '40001',
        MESSAGE = 'finance_governance_case_revision_conflict';
    END IF;
    v_previous := v_case.lifecycle_state;
    IF p_command = 'accept_work' THEN
      IF v_case.case_type <> 'work' OR v_case.lifecycle_state <> 'assigned'
         OR p_assignee_id IS NOT NULL
         OR v_case.assignee_actor_id IS DISTINCT FROM p_actor_id THEN
        RAISE EXCEPTION 'finance_governance_work_acceptance_invalid';
      END IF;
      UPDATE public.finance_governance_head_cases
         SET lifecycle_state = 'accepted', accepted_at = now(),
             revision = revision + 1, updated_at = now()
       WHERE id = p_case_id AND tenant_id = p_tenant_id
      RETURNING * INTO v_case;
    ELSIF p_command = 'escalate_work' THEN
      IF v_case.case_type <> 'work'
         OR v_case.lifecycle_state NOT IN ('assigned', 'accepted')
         OR v_case.assignee_actor_id IS DISTINCT FROM p_actor_id
         OR now() < v_case.sla_due_at
         OR p_escalation_code !~ '^[a-z][a-z0-9_]{2,79}$' THEN
        RAISE EXCEPTION 'finance_governance_work_escalation_invalid';
      END IF;
      UPDATE public.finance_governance_head_cases
         SET lifecycle_state = 'escalated', escalated_at = now(),
             escalation_code = p_escalation_code,
             revision = revision + 1, updated_at = now()
       WHERE id = p_case_id AND tenant_id = p_tenant_id
      RETURNING * INTO v_case;
    ELSIF p_command = 'complete_work' THEN
      IF v_case.case_type <> 'work'
         OR v_case.lifecycle_state NOT IN ('accepted', 'escalated')
         OR p_assignee_id IS NOT NULL
         OR v_case.assignee_actor_id IS DISTINCT FROM p_actor_id THEN
        RAISE EXCEPTION 'finance_governance_work_completion_invalid';
      END IF;
      UPDATE public.finance_governance_head_cases
         SET lifecycle_state = 'completed', completed_at = now(),
             completion_evidence_digest = v_evidence_digest,
             revision = revision + 1, updated_at = now()
       WHERE id = p_case_id AND tenant_id = p_tenant_id
      RETURNING * INTO v_case;
    ELSIF p_command = 'record_outcome' THEN
      IF v_case.case_type <> 'work'
         OR v_case.lifecycle_state <> 'completed'
         OR v_case.assignee_actor_id IS DISTINCT FROM p_actor_id
         OR v_case.outcome_state <> 'unknown'
         OR p_outcome_state NOT IN (
           'verified_achieved', 'verified_not_achieved', 'not_applicable'
         ) THEN
        RAISE EXCEPTION 'finance_governance_outcome_contract_invalid';
      END IF;
      UPDATE public.finance_governance_head_cases
         SET outcome_state = p_outcome_state, outcome_recorded_at = now(),
             outcome_evidence_digest = v_evidence_digest,
             revision = revision + 1, updated_at = now()
       WHERE id = p_case_id AND tenant_id = p_tenant_id
      RETURNING * INTO v_case;
    ELSIF p_command = 'complete_goal' THEN
      IF v_case.case_type <> 'goal' OR v_case.lifecycle_state <> 'active'
         OR p_outcome_state NOT IN (
           'verified_achieved', 'verified_not_achieved'
         ) THEN
        RAISE EXCEPTION 'finance_governance_goal_completion_invalid';
      END IF;
      UPDATE public.finance_governance_head_cases
         SET lifecycle_state = 'completed', completed_at = now(),
             completion_evidence_digest = v_evidence_digest,
             outcome_state = p_outcome_state, outcome_recorded_at = now(),
             outcome_evidence_digest = v_evidence_digest,
             revision = revision + 1, updated_at = now()
       WHERE id = p_case_id AND tenant_id = p_tenant_id
      RETURNING * INTO v_case;
    ELSIF p_command = 'decide_decision' THEN
      IF v_case.case_type <> 'decision' OR v_case.lifecycle_state <> 'pending'
         OR p_outcome_state NOT IN ('approved', 'rejected') THEN
        RAISE EXCEPTION 'finance_governance_decision_invalid';
      END IF;
      UPDATE public.finance_governance_head_cases
         SET lifecycle_state = 'completed', completed_at = now(),
             completion_evidence_digest = v_evidence_digest,
             decision_result = p_outcome_state,
             outcome_state = 'not_applicable', outcome_recorded_at = now(),
             outcome_evidence_digest = v_evidence_digest,
             revision = revision + 1, updated_at = now()
       WHERE id = p_case_id AND tenant_id = p_tenant_id
      RETURNING * INTO v_case;
    ELSE
      IF v_case.case_type <> 'exception' OR v_case.lifecycle_state <> 'open'
         OR p_outcome_state NOT IN (
           'verified_achieved', 'verified_not_achieved'
         ) THEN
        RAISE EXCEPTION 'finance_governance_exception_resolution_invalid';
      END IF;
      UPDATE public.finance_governance_head_cases
         SET lifecycle_state = 'resolved', completed_at = now(),
             completion_evidence_digest = v_evidence_digest,
             outcome_state = p_outcome_state, outcome_recorded_at = now(),
             outcome_evidence_digest = v_evidence_digest,
             revision = revision + 1, updated_at = now()
       WHERE id = p_case_id AND tenant_id = p_tenant_id
      RETURNING * INTO v_case;
    END IF;
    v_entity_type := 'case'; v_entity_id := p_case_id;
    v_resulting := CASE
      WHEN p_command IN ('record_outcome', 'complete_goal', 'resolve_exception')
        THEN v_case.outcome_state
      WHEN p_command = 'decide_decision' THEN v_case.decision_result
      ELSE v_case.lifecycle_state
    END;
    v_revision := v_case.revision;
  END IF;

  INSERT INTO public.finance_governance_head_events (
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
    'financial_truth_state', CASE WHEN v_entity_type = 'report'
      THEN v_report.financial_truth_state ELSE NULL END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.finance_governance_head_command_rpc(
  uuid, text, uuid, uuid, uuid, date, text, uuid[], text, text, text,
  jsonb, text, text, uuid, uuid, timestamptz, jsonb, text, text,
  bigint, text, text, text, text, jsonb, boolean
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finance_governance_head_command_rpc(
  uuid, text, uuid, uuid, uuid, date, text, uuid[], text, text, text,
  jsonb, text, text, uuid, uuid, timestamptz, jsonb, text, text,
  bigint, text, text, text, text, jsonb, boolean
) TO service_role;

CREATE OR REPLACE FUNCTION public.finance_governance_head_kill_switch_rpc(
  p_tenant_id uuid, p_reason text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE
  v_role text;
  v_digest text;
  v_revision bigint;
  v_control public.finance_governance_head_controls%ROWTYPE;
BEGIN
  v_role := COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    session_user::text
  );
  IF v_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'finance_governance_requires_service_role';
  END IF;
  IF p_tenant_id IS NULL
     OR char_length(btrim(COALESCE(p_reason, ''))) NOT BETWEEN 8 AND 240 THEN
    RAISE EXCEPTION 'finance_governance_kill_reason_required';
  END IF;
  v_digest := encode(digest(convert_to(p_reason, 'UTF8'), 'sha256'), 'hex');
  SELECT control.* INTO v_control
    FROM public.finance_governance_head_controls control
   WHERE control.tenant_id = p_tenant_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'finance_governance_control_not_found'; END IF;
  UPDATE public.finance_governance_head_controls
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
  RETURN jsonb_build_object(
    'outcome', 'contained', 'tenant_id', p_tenant_id,
    'revision', v_revision, 'reason_digest', v_digest
  );
END;
$$;

REVOKE ALL ON FUNCTION
  public.finance_governance_head_kill_switch_rpc(uuid, text)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.finance_governance_head_kill_switch_rpc(uuid, text)
TO service_role;
