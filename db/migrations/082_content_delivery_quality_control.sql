-- ============================================================================
-- Migration 082: Content delivery receipts and calibrated quality (G08/G09)
-- Date: 2026-07-24
--
-- Additive, default-off evidence/control plane around the existing content
-- planner and publisher. It does not alter content_drafts, invoke a provider,
-- publish content, or treat handler completion as delivery/business success.
--
-- ROLLBACK: db/rollbacks/082_content_delivery_quality_control_rollback.sql
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.content_delivery_automation_controls (
  tenant_id                  uuid PRIMARY KEY
                             REFERENCES public.tenants(id) ON DELETE CASCADE,
  enabled                    boolean NOT NULL DEFAULT false,
  execution_mode             text NOT NULL DEFAULT 'disabled'
                             CHECK (execution_mode IN ('disabled', 'shadow', 'supervised')),
  kill_switch_engaged        boolean NOT NULL DEFAULT true,
  provider_dispatch_enabled  boolean NOT NULL DEFAULT false
                             CHECK (provider_dispatch_enabled = false),
  revision                   bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  activated_by               uuid,
  activation_evidence        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.content_artifact_versions (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                  uuid NOT NULL
                             REFERENCES public.tenants(id) ON DELETE RESTRICT,
  content_draft_id           uuid NOT NULL
                             REFERENCES public.content_drafts(id) ON DELETE RESTRICT,
  version                    integer NOT NULL CHECK (version > 0),
  content_type               text NOT NULL
                             CHECK (content_type ~ '^[a-z][a-z0-9_]{1,63}$'),
  artifact_digest            text NOT NULL CHECK (artifact_digest ~ '^[a-f0-9]{64}$'),
  evidence_digest            text NOT NULL CHECK (evidence_digest ~ '^[a-f0-9]{64}$'),
  evidence_observed_at       timestamptz NOT NULL,
  actor_id                   text NOT NULL CHECK (char_length(btrim(actor_id)) BETWEEN 2 AND 160),
  idempotency_key            text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  request_fingerprint        text NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, content_draft_id, version),
  CHECK (evidence_observed_at <= created_at + interval '5 minutes')
);

CREATE TABLE IF NOT EXISTS public.content_quality_rubric_versions (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                  uuid NOT NULL
                             REFERENCES public.tenants(id) ON DELETE RESTRICT,
  rubric_key                 text NOT NULL
                             CHECK (rubric_key ~ '^[a-z][a-z0-9_]{1,63}$'),
  version                    integer NOT NULL CHECK (version > 0),
  acceptance_threshold       numeric(6,3) NOT NULL
                             CHECK (acceptance_threshold BETWEEN 0 AND 100),
  criteria                   jsonb NOT NULL
                             CHECK (jsonb_typeof(criteria) = 'object' AND criteria <> '{}'::jsonb),
  criteria_digest            text NOT NULL CHECK (criteria_digest ~ '^[a-f0-9]{64}$'),
  evidence_digest            text NOT NULL CHECK (evidence_digest ~ '^[a-f0-9]{64}$'),
  evidence_observed_at       timestamptz NOT NULL,
  actor_id                   text NOT NULL CHECK (char_length(btrim(actor_id)) BETWEEN 2 AND 160),
  idempotency_key            text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  request_fingerprint        text NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, rubric_key, version),
  CHECK (evidence_observed_at <= created_at + interval '5 minutes')
);

CREATE TABLE IF NOT EXISTS public.content_quality_calibrations (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                  uuid NOT NULL
                             REFERENCES public.tenants(id) ON DELETE RESTRICT,
  rubric_id                  uuid NOT NULL,
  calibration_version       integer NOT NULL CHECK (calibration_version > 0),
  benchmark_set_digest       text NOT NULL CHECK (benchmark_set_digest ~ '^[a-f0-9]{64}$'),
  scorer_config_digest       text NOT NULL CHECK (scorer_config_digest ~ '^[a-f0-9]{64}$'),
  sample_count               integer NOT NULL CHECK (sample_count > 0),
  agreement_basis_points     integer NOT NULL
                             CHECK (agreement_basis_points BETWEEN 0 AND 10000),
  evidence_digest            text NOT NULL CHECK (evidence_digest ~ '^[a-f0-9]{64}$'),
  evidence_observed_at       timestamptz NOT NULL,
  actor_id                   text NOT NULL CHECK (char_length(btrim(actor_id)) BETWEEN 2 AND 160),
  idempotency_key            text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  request_fingerprint        text NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, rubric_id, calibration_version),
  FOREIGN KEY (rubric_id, tenant_id)
    REFERENCES public.content_quality_rubric_versions(id, tenant_id) ON DELETE RESTRICT,
  CHECK (evidence_observed_at <= created_at + interval '5 minutes')
);

CREATE TABLE IF NOT EXISTS public.content_quality_evaluations (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                  uuid NOT NULL
                             REFERENCES public.tenants(id) ON DELETE RESTRICT,
  content_version_id         uuid NOT NULL,
  rubric_id                  uuid NOT NULL,
  calibration_id             uuid NOT NULL,
  overall_score              numeric(6,3) NOT NULL CHECK (overall_score BETWEEN 0 AND 100),
  category_scores            jsonb NOT NULL
                             CHECK (
                               jsonb_typeof(category_scores) = 'object'
                               AND category_scores <> '{}'::jsonb
                             ),
  quality_state              text NOT NULL
                             CHECK (quality_state IN ('accepted', 'rejected', 'unverified')),
  evidence_digest            text NOT NULL CHECK (evidence_digest ~ '^[a-f0-9]{64}$'),
  evidence_observed_at       timestamptz NOT NULL,
  actor_id                   text NOT NULL CHECK (char_length(btrim(actor_id)) BETWEEN 2 AND 160),
  idempotency_key            text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  request_fingerprint        text NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, content_version_id, rubric_id, calibration_id),
  FOREIGN KEY (content_version_id, tenant_id)
    REFERENCES public.content_artifact_versions(id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (rubric_id, tenant_id)
    REFERENCES public.content_quality_rubric_versions(id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (calibration_id, tenant_id)
    REFERENCES public.content_quality_calibrations(id, tenant_id) ON DELETE RESTRICT,
  CHECK (evidence_observed_at <= created_at + interval '5 minutes')
);

CREATE TABLE IF NOT EXISTS public.content_delivery_receipts (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                       uuid NOT NULL
                                  REFERENCES public.tenants(id) ON DELETE RESTRICT,
  content_version_id              uuid NOT NULL,
  quality_evaluation_id           uuid,
  owner_work_item_id              uuid,
  provider                        text NOT NULL
                                  CHECK (provider ~ '^[a-z][a-z0-9_]{1,63}$'),
  provider_account_ref            text NOT NULL
                                  CHECK (
                                    char_length(provider_account_ref) BETWEEN 2 AND 255
                                    AND provider_account_ref ~
                                      '^[A-Za-z0-9][A-Za-z0-9._:/-]{1,254}$'
                                  ),
  provider_delivery_id            text NOT NULL
                                  CHECK (
                                    char_length(provider_delivery_id) BETWEEN 2 AND 255
                                    AND provider_delivery_id ~
                                      '^[A-Za-z0-9][A-Za-z0-9._:/-]{1,254}$'
                                  ),
  destination_ref                 text NOT NULL
                                  CHECK (
                                    char_length(destination_ref) BETWEEN 2 AND 255
                                    AND destination_ref ~
                                      '^[A-Za-z0-9][A-Za-z0-9._:/-]{1,254}$'
                                  ),
  attempt_number                  integer NOT NULL CHECK (attempt_number > 0),
  execution_state                 text NOT NULL
                                  CHECK (execution_state IN ('completed', 'failed')),
  output_state                    text NOT NULL
                                  CHECK (output_state IN ('produced', 'no_output', 'no_op')),
  quality_state                   text NOT NULL
                                  CHECK (quality_state IN ('accepted', 'rejected', 'unverified')),
  delivery_state                  text NOT NULL
                                  CHECK (delivery_state IN (
                                    'accepted', 'delivered', 'failed', 'stuck', 'exception'
                                  )),
  business_effect_state           text NOT NULL
                                  CHECK (business_effect_state IN (
                                    'achieved', 'not_achieved', 'unverified', 'not_applicable'
                                  )),
  retry_state                     text NOT NULL
                                  CHECK (retry_state IN (
                                    'not_applicable', 'none', 'scheduled', 'exhausted'
                                  )),
  next_retry_at                   timestamptz,
  business_effect_evidence_digest text
                                  CHECK (
                                    business_effect_evidence_digest IS NULL
                                    OR business_effect_evidence_digest ~ '^[a-f0-9]{64}$'
                                  ),
  evidence_digest                 text NOT NULL CHECK (evidence_digest ~ '^[a-f0-9]{64}$'),
  evidence_observed_at            timestamptz NOT NULL,
  actor_id                        text NOT NULL
                                  CHECK (char_length(btrim(actor_id)) BETWEEN 2 AND 160),
  idempotency_key                 text NOT NULL
                                  CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  request_fingerprint             text NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  created_at                      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (provider, provider_account_ref, provider_delivery_id),
  UNIQUE (
    tenant_id, content_version_id, provider, destination_ref, attempt_number
  ),
  FOREIGN KEY (content_version_id, tenant_id)
    REFERENCES public.content_artifact_versions(id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (quality_evaluation_id, tenant_id)
    REFERENCES public.content_quality_evaluations(id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (owner_work_item_id, tenant_id)
    REFERENCES public.work_items(id, tenant_id) ON DELETE RESTRICT,
  CHECK (evidence_observed_at <= created_at + interval '5 minutes'),
  CHECK (
    output_state = 'produced'
    OR (
      quality_state <> 'accepted'
      AND delivery_state <> 'delivered'
      AND business_effect_state <> 'achieved'
    )
  ),
  CHECK (
    delivery_state <> 'delivered'
    OR (
      execution_state = 'completed'
      AND output_state = 'produced'
      AND quality_state = 'accepted'
      AND quality_evaluation_id IS NOT NULL
    )
  ),
  CHECK (
    (quality_state = 'unverified' AND quality_evaluation_id IS NULL)
    OR (
      quality_state IN ('accepted', 'rejected')
      AND quality_evaluation_id IS NOT NULL
    )
  ),
  CHECK (
    delivery_state NOT IN ('failed', 'stuck', 'exception')
    OR owner_work_item_id IS NOT NULL
  ),
  CHECK (
    (retry_state = 'scheduled' AND next_retry_at IS NOT NULL)
    OR (retry_state <> 'scheduled' AND next_retry_at IS NULL)
  ),
  CHECK (next_retry_at IS NULL OR next_retry_at > evidence_observed_at),
  CHECK (
    (
      business_effect_state IN ('achieved', 'not_achieved')
      AND business_effect_evidence_digest IS NOT NULL
    )
    OR (
      business_effect_state IN ('unverified', 'not_applicable')
      AND business_effect_evidence_digest IS NULL
    )
  ),
  CHECK (
    business_effect_state <> 'achieved'
    OR (
      output_state = 'produced'
      AND quality_state = 'accepted'
      AND delivery_state = 'delivered'
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_content_artifact_versions_draft
  ON public.content_artifact_versions (tenant_id, content_draft_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_content_quality_evaluations_version
  ON public.content_quality_evaluations (tenant_id, content_version_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_content_delivery_receipts_state
  ON public.content_delivery_receipts (
    tenant_id, delivery_state, retry_state, next_retry_at, created_at DESC
  );
CREATE INDEX IF NOT EXISTS idx_content_delivery_receipts_work
  ON public.content_delivery_receipts (tenant_id, owner_work_item_id)
  WHERE owner_work_item_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.content_delivery_immutable_row()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'content_delivery_evidence_is_immutable';
END;
$$;

DO $$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'content_artifact_versions',
    'content_quality_rubric_versions',
    'content_quality_calibrations',
    'content_quality_evaluations',
    'content_delivery_receipts'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I',
      'trg_' || v_table || '_immutable', v_table);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I ' ||
      'FOR EACH ROW EXECUTE FUNCTION public.content_delivery_immutable_row()',
      'trg_' || v_table || '_immutable', v_table
    );
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.content_delivery_control_guard()
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
      MESSAGE = 'content_delivery_kill_switch_is_one_way';
  END IF;
  IF NEW.enabled = true AND (
    NEW.execution_mode NOT IN ('shadow', 'supervised')
    OR NEW.kill_switch_engaged IS DISTINCT FROM false
    OR NEW.provider_dispatch_enabled IS DISTINCT FROM false
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
      MESSAGE = 'content_delivery_activation_invalid';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    NEW.revision := OLD.revision + 1;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_content_delivery_control_guard
  ON public.content_delivery_automation_controls;
CREATE TRIGGER trg_content_delivery_control_guard
  BEFORE INSERT OR UPDATE ON public.content_delivery_automation_controls
  FOR EACH ROW EXECUTE FUNCTION public.content_delivery_control_guard();

CREATE OR REPLACE FUNCTION public.content_delivery_reference_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_threshold numeric;
BEGIN
  IF TG_TABLE_NAME = 'content_artifact_versions' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.content_drafts draft
       WHERE draft.id = NEW.content_draft_id
         AND draft.tenant_id = NEW.tenant_id
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'content_artifact_draft_not_found_for_tenant';
    END IF;
  ELSIF TG_TABLE_NAME = 'content_quality_evaluations' THEN
    IF EXISTS (
      SELECT 1
        FROM jsonb_each(NEW.category_scores) score
       WHERE jsonb_typeof(score.value) <> 'number'
          OR (score.value #>> '{}')::numeric NOT BETWEEN 0 AND 100
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'content_quality_category_score_invalid';
    END IF;
    IF NOT EXISTS (
      SELECT 1
        FROM public.content_quality_calibrations calibration
       WHERE calibration.id = NEW.calibration_id
         AND calibration.tenant_id = NEW.tenant_id
         AND calibration.rubric_id = NEW.rubric_id
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'content_quality_calibration_rubric_mismatch';
    END IF;
    SELECT rubric.acceptance_threshold INTO STRICT v_threshold
      FROM public.content_quality_rubric_versions rubric
     WHERE rubric.id = NEW.rubric_id
       AND rubric.tenant_id = NEW.tenant_id;
    IF (NEW.quality_state = 'accepted' AND NEW.overall_score < v_threshold)
       OR (NEW.quality_state = 'rejected' AND NEW.overall_score >= v_threshold) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'content_quality_state_threshold_mismatch';
    END IF;
  ELSIF TG_TABLE_NAME = 'content_delivery_receipts' THEN
    IF NEW.quality_evaluation_id IS NOT NULL AND NOT EXISTS (
      SELECT 1
        FROM public.content_quality_evaluations evaluation
       WHERE evaluation.id = NEW.quality_evaluation_id
         AND evaluation.tenant_id = NEW.tenant_id
         AND evaluation.content_version_id = NEW.content_version_id
         AND evaluation.quality_state = NEW.quality_state
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'content_delivery_quality_evidence_mismatch';
    END IF;
    IF NEW.owner_work_item_id IS NOT NULL AND NOT EXISTS (
      SELECT 1
        FROM public.work_items work
       WHERE work.id = NEW.owner_work_item_id
         AND work.tenant_id = NEW.tenant_id
         AND work.authority_tier = 'owner'
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'content_delivery_owner_work_not_found_for_tenant';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_content_artifact_versions_reference_guard
  ON public.content_artifact_versions;
CREATE TRIGGER trg_content_artifact_versions_reference_guard
  BEFORE INSERT ON public.content_artifact_versions
  FOR EACH ROW EXECUTE FUNCTION public.content_delivery_reference_guard();
DROP TRIGGER IF EXISTS trg_content_quality_evaluations_reference_guard
  ON public.content_quality_evaluations;
CREATE TRIGGER trg_content_quality_evaluations_reference_guard
  BEFORE INSERT ON public.content_quality_evaluations
  FOR EACH ROW EXECUTE FUNCTION public.content_delivery_reference_guard();
DROP TRIGGER IF EXISTS trg_content_delivery_receipts_reference_guard
  ON public.content_delivery_receipts;
CREATE TRIGGER trg_content_delivery_receipts_reference_guard
  BEFORE INSERT ON public.content_delivery_receipts
  FOR EACH ROW EXECUTE FUNCTION public.content_delivery_reference_guard();

DO $$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'content_delivery_automation_controls',
    'content_artifact_versions',
    'content_quality_rubric_versions',
    'content_quality_calibrations',
    'content_quality_evaluations',
    'content_delivery_receipts'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_table);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I',
      'tenant_iso_' || v_table, v_table);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (' ||
      'tenant_id = NULLIF(auth.jwt()->''app_metadata''->>''tenant_id'', '''')::uuid ' ||
      'AND auth.jwt()->''app_metadata''->>''role'' IN (' ||
      '''owner'', ''platform_owner'', ''founder'', ''admin'', ' ||
      '''client_owner'', ''tenant_owner''))',
      'tenant_iso_' || v_table, v_table
    );
  END LOOP;
END $$;

GRANT SELECT ON
  public.content_delivery_automation_controls,
  public.content_artifact_versions,
  public.content_quality_rubric_versions,
  public.content_quality_calibrations,
  public.content_quality_evaluations,
  public.content_delivery_receipts
TO authenticated, service_role;
REVOKE INSERT, UPDATE, DELETE ON
  public.content_delivery_automation_controls,
  public.content_artifact_versions,
  public.content_quality_rubric_versions,
  public.content_quality_calibrations,
  public.content_quality_evaluations,
  public.content_delivery_receipts
FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.content_delivery_assert_control(
  p_tenant_id uuid,
  p_feature_gate_enabled boolean
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_claims text;
  v_calling_role text;
  v_control public.content_delivery_automation_controls%ROWTYPE;
BEGIN
  v_claims := NULLIF(current_setting('request.jwt.claims', true), '');
  v_calling_role := COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    CASE WHEN v_claims IS NOT NULL THEN v_claims::jsonb ->> 'role' END,
    session_user::text
  );
  IF v_calling_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'content_delivery_requires_service_role';
  END IF;
  IF p_feature_gate_enabled IS DISTINCT FROM true THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'content_delivery_writes_disabled';
  END IF;
  SELECT control.* INTO STRICT v_control
    FROM public.content_delivery_automation_controls control
   WHERE control.tenant_id = p_tenant_id
   FOR UPDATE;
  IF v_control.enabled IS DISTINCT FROM true
     OR v_control.execution_mode NOT IN ('shadow', 'supervised')
     OR v_control.kill_switch_engaged IS DISTINCT FROM false
     OR v_control.provider_dispatch_enabled IS DISTINCT FROM false THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'content_delivery_control_not_active';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.content_artifact_version_register_rpc(
  p_tenant_id uuid,
  p_content_draft_id uuid,
  p_version integer,
  p_content_type text,
  p_artifact_digest text,
  p_evidence_digest text,
  p_evidence_observed_at timestamptz,
  p_actor_id text,
  p_idempotency_key text,
  p_request_fingerprint text,
  p_feature_gate_enabled boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_existing public.content_artifact_versions%ROWTYPE;
  v_record public.content_artifact_versions%ROWTYPE;
BEGIN
  PERFORM public.content_delivery_assert_control(p_tenant_id, p_feature_gate_enabled);
  SELECT item.* INTO v_existing
    FROM public.content_artifact_versions item
   WHERE item.tenant_id = p_tenant_id
     AND item.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.request_fingerprint IS DISTINCT FROM p_request_fingerprint
       OR v_existing.content_draft_id IS DISTINCT FROM p_content_draft_id
       OR v_existing.version IS DISTINCT FROM p_version
       OR v_existing.content_type IS DISTINCT FROM p_content_type
       OR v_existing.artifact_digest IS DISTINCT FROM p_artifact_digest
       OR v_existing.evidence_digest IS DISTINCT FROM p_evidence_digest
       OR v_existing.evidence_observed_at IS DISTINCT FROM p_evidence_observed_at
       OR v_existing.actor_id IS DISTINCT FROM p_actor_id THEN
      RAISE EXCEPTION USING ERRCODE = '23505',
        MESSAGE = 'content_artifact_version_idempotency_conflict';
    END IF;
    RETURN jsonb_build_object('outcome', 'replay', 'content_version', to_jsonb(v_existing));
  END IF;
  INSERT INTO public.content_artifact_versions (
    tenant_id, content_draft_id, version, content_type, artifact_digest,
    evidence_digest, evidence_observed_at, actor_id, idempotency_key,
    request_fingerprint
  ) VALUES (
    p_tenant_id, p_content_draft_id, p_version, p_content_type,
    p_artifact_digest, p_evidence_digest, p_evidence_observed_at, p_actor_id,
    p_idempotency_key, p_request_fingerprint
  ) RETURNING * INTO v_record;
  RETURN jsonb_build_object('outcome', 'registered', 'content_version', to_jsonb(v_record));
END;
$$;

CREATE OR REPLACE FUNCTION public.content_quality_rubric_register_rpc(
  p_tenant_id uuid,
  p_rubric_key text,
  p_version integer,
  p_acceptance_threshold numeric,
  p_criteria jsonb,
  p_criteria_digest text,
  p_evidence_digest text,
  p_evidence_observed_at timestamptz,
  p_actor_id text,
  p_idempotency_key text,
  p_request_fingerprint text,
  p_feature_gate_enabled boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_existing public.content_quality_rubric_versions%ROWTYPE;
  v_record public.content_quality_rubric_versions%ROWTYPE;
BEGIN
  PERFORM public.content_delivery_assert_control(p_tenant_id, p_feature_gate_enabled);
  SELECT item.* INTO v_existing
    FROM public.content_quality_rubric_versions item
   WHERE item.tenant_id = p_tenant_id
     AND item.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.request_fingerprint IS DISTINCT FROM p_request_fingerprint
       OR v_existing.rubric_key IS DISTINCT FROM p_rubric_key
       OR v_existing.version IS DISTINCT FROM p_version
       OR v_existing.acceptance_threshold IS DISTINCT FROM p_acceptance_threshold
       OR v_existing.criteria IS DISTINCT FROM p_criteria
       OR v_existing.criteria_digest IS DISTINCT FROM p_criteria_digest
       OR v_existing.evidence_digest IS DISTINCT FROM p_evidence_digest
       OR v_existing.evidence_observed_at IS DISTINCT FROM p_evidence_observed_at
       OR v_existing.actor_id IS DISTINCT FROM p_actor_id THEN
      RAISE EXCEPTION USING ERRCODE = '23505',
        MESSAGE = 'content_quality_rubric_idempotency_conflict';
    END IF;
    RETURN jsonb_build_object('outcome', 'replay', 'rubric', to_jsonb(v_existing));
  END IF;
  INSERT INTO public.content_quality_rubric_versions (
    tenant_id, rubric_key, version, acceptance_threshold, criteria,
    criteria_digest, evidence_digest, evidence_observed_at, actor_id,
    idempotency_key, request_fingerprint
  ) VALUES (
    p_tenant_id, p_rubric_key, p_version, p_acceptance_threshold, p_criteria,
    p_criteria_digest, p_evidence_digest, p_evidence_observed_at, p_actor_id,
    p_idempotency_key, p_request_fingerprint
  ) RETURNING * INTO v_record;
  RETURN jsonb_build_object('outcome', 'registered', 'rubric', to_jsonb(v_record));
END;
$$;

CREATE OR REPLACE FUNCTION public.content_quality_calibration_record_rpc(
  p_tenant_id uuid,
  p_rubric_id uuid,
  p_sample_count integer,
  p_agreement_basis_points integer,
  p_benchmark_set_digest text,
  p_scorer_config_digest text,
  p_evidence_digest text,
  p_evidence_observed_at timestamptz,
  p_actor_id text,
  p_idempotency_key text,
  p_request_fingerprint text,
  p_feature_gate_enabled boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_existing public.content_quality_calibrations%ROWTYPE;
  v_record public.content_quality_calibrations%ROWTYPE;
  v_next_version integer;
BEGIN
  PERFORM public.content_delivery_assert_control(p_tenant_id, p_feature_gate_enabled);
  IF NOT EXISTS (
    SELECT 1 FROM public.content_quality_rubric_versions rubric
     WHERE rubric.id = p_rubric_id AND rubric.tenant_id = p_tenant_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'content_quality_rubric_not_found_for_tenant';
  END IF;
  SELECT item.* INTO v_existing
    FROM public.content_quality_calibrations item
   WHERE item.tenant_id = p_tenant_id
     AND item.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.request_fingerprint IS DISTINCT FROM p_request_fingerprint
       OR v_existing.rubric_id IS DISTINCT FROM p_rubric_id
       OR v_existing.sample_count IS DISTINCT FROM p_sample_count
       OR v_existing.agreement_basis_points IS DISTINCT FROM p_agreement_basis_points
       OR v_existing.benchmark_set_digest IS DISTINCT FROM p_benchmark_set_digest
       OR v_existing.scorer_config_digest IS DISTINCT FROM p_scorer_config_digest
       OR v_existing.evidence_digest IS DISTINCT FROM p_evidence_digest
       OR v_existing.evidence_observed_at IS DISTINCT FROM p_evidence_observed_at
       OR v_existing.actor_id IS DISTINCT FROM p_actor_id THEN
      RAISE EXCEPTION USING ERRCODE = '23505',
        MESSAGE = 'content_quality_calibration_idempotency_conflict';
    END IF;
    RETURN jsonb_build_object('outcome', 'replay', 'calibration', to_jsonb(v_existing));
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':' || p_rubric_id::text, 0));
  SELECT COALESCE(max(item.calibration_version), 0) + 1 INTO v_next_version
    FROM public.content_quality_calibrations item
   WHERE item.tenant_id = p_tenant_id AND item.rubric_id = p_rubric_id;
  INSERT INTO public.content_quality_calibrations (
    tenant_id, rubric_id, calibration_version, benchmark_set_digest,
    scorer_config_digest, sample_count, agreement_basis_points,
    evidence_digest, evidence_observed_at, actor_id, idempotency_key,
    request_fingerprint
  ) VALUES (
    p_tenant_id, p_rubric_id, v_next_version, p_benchmark_set_digest,
    p_scorer_config_digest, p_sample_count, p_agreement_basis_points,
    p_evidence_digest, p_evidence_observed_at, p_actor_id, p_idempotency_key,
    p_request_fingerprint
  ) RETURNING * INTO v_record;
  RETURN jsonb_build_object('outcome', 'recorded', 'calibration', to_jsonb(v_record));
END;
$$;

CREATE OR REPLACE FUNCTION public.content_quality_evaluation_record_rpc(
  p_tenant_id uuid,
  p_content_version_id uuid,
  p_rubric_id uuid,
  p_calibration_id uuid,
  p_overall_score numeric,
  p_category_scores jsonb,
  p_quality_state text,
  p_evidence_digest text,
  p_evidence_observed_at timestamptz,
  p_actor_id text,
  p_idempotency_key text,
  p_request_fingerprint text,
  p_feature_gate_enabled boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_existing public.content_quality_evaluations%ROWTYPE;
  v_record public.content_quality_evaluations%ROWTYPE;
BEGIN
  PERFORM public.content_delivery_assert_control(p_tenant_id, p_feature_gate_enabled);
  SELECT item.* INTO v_existing
    FROM public.content_quality_evaluations item
   WHERE item.tenant_id = p_tenant_id
     AND item.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.request_fingerprint IS DISTINCT FROM p_request_fingerprint
       OR v_existing.content_version_id IS DISTINCT FROM p_content_version_id
       OR v_existing.rubric_id IS DISTINCT FROM p_rubric_id
       OR v_existing.calibration_id IS DISTINCT FROM p_calibration_id
       OR v_existing.overall_score IS DISTINCT FROM p_overall_score
       OR v_existing.category_scores IS DISTINCT FROM p_category_scores
       OR v_existing.quality_state IS DISTINCT FROM p_quality_state
       OR v_existing.evidence_digest IS DISTINCT FROM p_evidence_digest
       OR v_existing.evidence_observed_at IS DISTINCT FROM p_evidence_observed_at
       OR v_existing.actor_id IS DISTINCT FROM p_actor_id THEN
      RAISE EXCEPTION USING ERRCODE = '23505',
        MESSAGE = 'content_quality_evaluation_idempotency_conflict';
    END IF;
    RETURN jsonb_build_object('outcome', 'replay', 'evaluation', to_jsonb(v_existing));
  END IF;
  INSERT INTO public.content_quality_evaluations (
    tenant_id, content_version_id, rubric_id, calibration_id, overall_score,
    category_scores, quality_state, evidence_digest, evidence_observed_at,
    actor_id, idempotency_key, request_fingerprint
  ) VALUES (
    p_tenant_id, p_content_version_id, p_rubric_id, p_calibration_id,
    p_overall_score, p_category_scores, p_quality_state, p_evidence_digest,
    p_evidence_observed_at, p_actor_id, p_idempotency_key,
    p_request_fingerprint
  ) RETURNING * INTO v_record;
  RETURN jsonb_build_object('outcome', 'recorded', 'evaluation', to_jsonb(v_record));
END;
$$;

CREATE OR REPLACE FUNCTION public.content_delivery_receipt_record_rpc(
  p_tenant_id uuid,
  p_content_version_id uuid,
  p_quality_evaluation_id uuid,
  p_owner_work_item_id uuid,
  p_provider text,
  p_provider_account_ref text,
  p_provider_delivery_id text,
  p_destination_ref text,
  p_attempt_number integer,
  p_execution_state text,
  p_output_state text,
  p_quality_state text,
  p_delivery_state text,
  p_business_effect_state text,
  p_retry_state text,
  p_next_retry_at timestamptz,
  p_business_effect_evidence_digest text,
  p_evidence_digest text,
  p_evidence_observed_at timestamptz,
  p_actor_id text,
  p_idempotency_key text,
  p_request_fingerprint text,
  p_feature_gate_enabled boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_existing public.content_delivery_receipts%ROWTYPE;
  v_record public.content_delivery_receipts%ROWTYPE;
  v_identity public.content_delivery_receipts%ROWTYPE;
BEGIN
  PERFORM public.content_delivery_assert_control(p_tenant_id, p_feature_gate_enabled);
  SELECT item.* INTO v_existing
    FROM public.content_delivery_receipts item
   WHERE item.tenant_id = p_tenant_id
     AND item.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.request_fingerprint IS DISTINCT FROM p_request_fingerprint
       OR v_existing.content_version_id IS DISTINCT FROM p_content_version_id
       OR v_existing.quality_evaluation_id IS DISTINCT FROM p_quality_evaluation_id
       OR v_existing.owner_work_item_id IS DISTINCT FROM p_owner_work_item_id
       OR v_existing.provider IS DISTINCT FROM p_provider
       OR v_existing.provider_account_ref IS DISTINCT FROM p_provider_account_ref
       OR v_existing.provider_delivery_id IS DISTINCT FROM p_provider_delivery_id
       OR v_existing.destination_ref IS DISTINCT FROM p_destination_ref
       OR v_existing.attempt_number IS DISTINCT FROM p_attempt_number
       OR v_existing.execution_state IS DISTINCT FROM p_execution_state
       OR v_existing.output_state IS DISTINCT FROM p_output_state
       OR v_existing.quality_state IS DISTINCT FROM p_quality_state
       OR v_existing.delivery_state IS DISTINCT FROM p_delivery_state
       OR v_existing.business_effect_state IS DISTINCT FROM p_business_effect_state
       OR v_existing.retry_state IS DISTINCT FROM p_retry_state
       OR v_existing.next_retry_at IS DISTINCT FROM p_next_retry_at
       OR v_existing.business_effect_evidence_digest IS DISTINCT FROM
          p_business_effect_evidence_digest
       OR v_existing.evidence_digest IS DISTINCT FROM p_evidence_digest
       OR v_existing.evidence_observed_at IS DISTINCT FROM p_evidence_observed_at
       OR v_existing.actor_id IS DISTINCT FROM p_actor_id THEN
      RAISE EXCEPTION USING ERRCODE = '23505',
        MESSAGE = 'content_delivery_receipt_idempotency_conflict';
    END IF;
    RETURN jsonb_build_object('outcome', 'replay', 'receipt', to_jsonb(v_existing));
  END IF;
  SELECT item.* INTO v_identity
    FROM public.content_delivery_receipts item
   WHERE item.provider = p_provider
     AND item.provider_account_ref = p_provider_account_ref
     AND item.provider_delivery_id = p_provider_delivery_id;
  IF FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23505',
      MESSAGE = 'content_delivery_provider_identity_conflict';
  END IF;
  INSERT INTO public.content_delivery_receipts (
    tenant_id, content_version_id, quality_evaluation_id, owner_work_item_id,
    provider, provider_account_ref, provider_delivery_id, destination_ref,
    attempt_number, execution_state, output_state, quality_state,
    delivery_state, business_effect_state, retry_state, next_retry_at,
    business_effect_evidence_digest, evidence_digest, evidence_observed_at,
    actor_id, idempotency_key, request_fingerprint
  ) VALUES (
    p_tenant_id, p_content_version_id, p_quality_evaluation_id,
    p_owner_work_item_id, p_provider, p_provider_account_ref,
    p_provider_delivery_id, p_destination_ref, p_attempt_number,
    p_execution_state, p_output_state, p_quality_state, p_delivery_state,
    p_business_effect_state, p_retry_state, p_next_retry_at,
    p_business_effect_evidence_digest, p_evidence_digest,
    p_evidence_observed_at, p_actor_id, p_idempotency_key,
    p_request_fingerprint
  ) RETURNING * INTO v_record;
  RETURN jsonb_build_object('outcome', 'recorded', 'receipt', to_jsonb(v_record));
END;
$$;

REVOKE ALL ON FUNCTION public.content_delivery_assert_control(uuid, boolean)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.content_artifact_version_register_rpc(
  uuid, uuid, integer, text, text, text, timestamptz, text, text, text, boolean
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.content_quality_rubric_register_rpc(
  uuid, text, integer, numeric, jsonb, text, text, timestamptz, text, text,
  text, boolean
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.content_quality_calibration_record_rpc(
  uuid, uuid, integer, integer, text, text, text, timestamptz, text, text,
  text, boolean
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.content_quality_evaluation_record_rpc(
  uuid, uuid, uuid, uuid, numeric, jsonb, text, text, timestamptz, text,
  text, text, boolean
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.content_delivery_receipt_record_rpc(
  uuid, uuid, uuid, uuid, text, text, text, text, integer, text, text, text,
  text, text, text, timestamptz, text, text, timestamptz, text, text, text,
  boolean
) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.content_artifact_version_register_rpc(
  uuid, uuid, integer, text, text, text, timestamptz, text, text, text, boolean
) TO service_role;
GRANT EXECUTE ON FUNCTION public.content_quality_rubric_register_rpc(
  uuid, text, integer, numeric, jsonb, text, text, timestamptz, text, text,
  text, boolean
) TO service_role;
GRANT EXECUTE ON FUNCTION public.content_quality_calibration_record_rpc(
  uuid, uuid, integer, integer, text, text, text, timestamptz, text, text,
  text, boolean
) TO service_role;
GRANT EXECUTE ON FUNCTION public.content_quality_evaluation_record_rpc(
  uuid, uuid, uuid, uuid, numeric, jsonb, text, text, timestamptz, text,
  text, text, boolean
) TO service_role;
GRANT EXECUTE ON FUNCTION public.content_delivery_receipt_record_rpc(
  uuid, uuid, uuid, uuid, text, text, text, text, integer, text, text, text,
  text, text, text, timestamptz, text, text, timestamptz, text, text, text,
  boolean
) TO service_role;

-- Fail-safe control is deliberately independent of the feature gate. It can
-- only move a tenant toward containment and returns no activation evidence or
-- supplied reason text.
CREATE OR REPLACE FUNCTION public.content_delivery_kill_switch_rpc(
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
  v_control public.content_delivery_automation_controls%ROWTYPE;
  v_reason_digest text;
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
      MESSAGE = 'content_delivery_kill_switch_requires_service_role';
  END IF;
  IF p_tenant_id IS NULL
     OR btrim(COALESCE(p_reason, '')) !~ '^[a-z][a-z0-9_:-]{2,79}$' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'content_delivery_kill_switch_reason_invalid';
  END IF;
  v_reason_digest := encode(digest(btrim(p_reason), 'sha256'), 'hex');

  UPDATE public.content_delivery_automation_controls
     SET enabled = false,
         execution_mode = 'disabled',
         kill_switch_engaged = true,
         activation_evidence = activation_evidence || jsonb_build_object(
           'kill_switch_reason_digest', v_reason_digest,
           'kill_switch_engaged_at', now()
         )
   WHERE tenant_id = p_tenant_id
  RETURNING * INTO v_control;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'content_delivery_control_not_found';
  END IF;
  RETURN jsonb_build_object(
    'outcome', 'kill_switch_engaged',
    'tenant_id', v_control.tenant_id,
    'revision', v_control.revision
  );
END;
$$;

REVOKE ALL ON FUNCTION public.content_delivery_kill_switch_rpc(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.content_delivery_kill_switch_rpc(uuid, text)
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.content_delivery_immutable_row()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.content_delivery_control_guard()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.content_delivery_reference_guard()
  FROM PUBLIC, anon, authenticated, service_role;
