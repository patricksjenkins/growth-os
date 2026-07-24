-- ============================================================================
-- Migration 081: Monthly finance-close operating control (G16)
-- Date: 2026-07-24
--
-- Additive, default-off, shadow/supervised-only control plane. This migration
-- does not calculate or rewrite finance totals, call an export provider, or
-- mutate the deployed finance_period_locks table. A recorded "shadow_locked"
-- state is evidence that the close workflow reached its lock gate; it is not a
-- production ledger lock.
--
-- ROLLBACK: db/rollbacks/081_monthly_finance_close_control_rollback.sql
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.finance_close_automation_controls (
  tenant_id                         uuid PRIMARY KEY
                                    REFERENCES public.tenants(id) ON DELETE CASCADE,
  enabled                           boolean NOT NULL DEFAULT false,
  execution_mode                    text NOT NULL DEFAULT 'disabled'
                                    CHECK (execution_mode IN (
                                      'disabled', 'shadow', 'supervised'
                                    )),
  kill_switch_engaged               boolean NOT NULL DEFAULT true,
  provider_export_enabled           boolean NOT NULL DEFAULT false
                                    CHECK (provider_export_enabled = false),
  production_period_lock_enabled    boolean NOT NULL DEFAULT false
                                    CHECK (production_period_lock_enabled = false),
  revision                          bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  activated_by                      uuid,
  activation_evidence               jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                        timestamptz NOT NULL DEFAULT now(),
  updated_at                        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.finance_close_cycles (
  id                                uuid PRIMARY KEY,
  tenant_id                         uuid NOT NULL
                                    REFERENCES public.tenants(id) ON DELETE RESTRICT,
  period_start                      date NOT NULL,
  currency                          text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  close_state                       text NOT NULL DEFAULT 'not_started'
                                    CHECK (close_state IN (
                                      'not_started', 'reconciling',
                                      'exception_review', 'review_ready',
                                      'reviewer_approved', 'signed_off',
                                      'exported', 'shadow_locked'
                                    )),
  revision                          bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  reconciliation_manifest_digest    text
                                    CHECK (
                                      reconciliation_manifest_digest IS NULL
                                      OR reconciliation_manifest_digest ~ '^[a-f0-9]{64}$'
                                    ),
  reconciliation_record_count       integer NOT NULL DEFAULT 0
                                    CHECK (reconciliation_record_count >= 0),
  reviewer_id                       uuid,
  reviewed_at                       timestamptz,
  signatory_id                      uuid,
  signed_off_at                     timestamptz,
  export_receipt_digest             text
                                    CHECK (
                                      export_receipt_digest IS NULL
                                      OR export_receipt_digest ~ '^[a-f0-9]{64}$'
                                    ),
  exported_at                       timestamptz,
  shadow_lock_evidence_digest       text
                                    CHECK (
                                      shadow_lock_evidence_digest IS NULL
                                      OR shadow_lock_evidence_digest ~ '^[a-f0-9]{64}$'
                                    ),
  shadow_locked_at                  timestamptz,
  production_period_lock_applied    boolean NOT NULL DEFAULT false
                                    CHECK (production_period_lock_applied = false),
  last_action_at                    timestamptz,
  created_at                        timestamptz NOT NULL DEFAULT now(),
  updated_at                        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, period_start, currency),
  UNIQUE (id, tenant_id),
  CHECK (period_start = date_trunc('month', period_start)::date),
  CHECK (
    (reviewer_id IS NULL AND reviewed_at IS NULL)
    OR (reviewer_id IS NOT NULL AND reviewed_at IS NOT NULL)
  ),
  CHECK (
    (signatory_id IS NULL AND signed_off_at IS NULL)
    OR (signatory_id IS NOT NULL AND signed_off_at IS NOT NULL)
  ),
  CHECK (
    (export_receipt_digest IS NULL AND exported_at IS NULL)
    OR (export_receipt_digest IS NOT NULL AND exported_at IS NOT NULL)
  ),
  CHECK (
    (shadow_lock_evidence_digest IS NULL AND shadow_locked_at IS NULL)
    OR (shadow_lock_evidence_digest IS NOT NULL AND shadow_locked_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS public.finance_close_exceptions (
  id                                uuid PRIMARY KEY,
  tenant_id                         uuid NOT NULL,
  finance_close_cycle_id            uuid NOT NULL,
  exception_code                    text NOT NULL
                                    CHECK (exception_code ~ '^[a-z][a-z0-9_]{2,79}$'),
  status                            text NOT NULL DEFAULT 'open'
                                    CHECK (status IN ('open', 'resolved')),
  owner_id                          uuid NOT NULL,
  due_at                            timestamptz NOT NULL,
  opened_at                         timestamptz NOT NULL DEFAULT now(),
  resolved_at                       timestamptz,
  resolution_evidence_digest        text
                                    CHECK (
                                      resolution_evidence_digest IS NULL
                                      OR resolution_evidence_digest ~ '^[a-f0-9]{64}$'
                                    ),
  UNIQUE (id, tenant_id),
  UNIQUE (finance_close_cycle_id, exception_code),
  FOREIGN KEY (finance_close_cycle_id, tenant_id)
    REFERENCES public.finance_close_cycles(id, tenant_id) ON DELETE RESTRICT,
  CHECK (
    (status = 'open' AND resolved_at IS NULL
      AND resolution_evidence_digest IS NULL)
    OR
    (status = 'resolved' AND resolved_at IS NOT NULL
      AND resolution_evidence_digest IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS public.finance_close_tasks (
  id                                uuid PRIMARY KEY,
  tenant_id                         uuid NOT NULL,
  finance_close_cycle_id            uuid NOT NULL,
  finance_close_exception_id        uuid,
  task_type                         text NOT NULL
                                    CHECK (task_type IN (
                                      'reconciliation', 'exception_resolution',
                                      'review', 'export', 'lock_review'
                                    )),
  status                            text NOT NULL DEFAULT 'assigned'
                                    CHECK (status IN (
                                      'assigned', 'accepted', 'escalated', 'completed'
                                    )),
  assignee_id                       uuid NOT NULL,
  assigned_at                       timestamptz NOT NULL DEFAULT now(),
  accepted_at                       timestamptz,
  due_at                            timestamptz NOT NULL,
  escalated_at                      timestamptz,
  escalation_code                   text,
  completed_at                      timestamptz,
  completion_evidence_digest        text
                                    CHECK (
                                      completion_evidence_digest IS NULL
                                      OR completion_evidence_digest ~ '^[a-f0-9]{64}$'
                                    ),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (finance_close_cycle_id, tenant_id)
    REFERENCES public.finance_close_cycles(id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (finance_close_exception_id, tenant_id)
    REFERENCES public.finance_close_exceptions(id, tenant_id) ON DELETE RESTRICT,
  CHECK (
    finance_close_exception_id IS NULL
    OR task_type = 'exception_resolution'
  ),
  CHECK (
    (status = 'assigned' AND accepted_at IS NULL AND escalated_at IS NULL
      AND completed_at IS NULL AND completion_evidence_digest IS NULL)
    OR
    (status = 'accepted' AND accepted_at IS NOT NULL AND escalated_at IS NULL
      AND completed_at IS NULL AND completion_evidence_digest IS NULL)
    OR
    (status = 'escalated' AND escalated_at IS NOT NULL
      AND NULLIF(btrim(escalation_code), '') IS NOT NULL
      AND completed_at IS NULL AND completion_evidence_digest IS NULL)
    OR
    (status = 'completed' AND accepted_at IS NOT NULL
      AND completed_at IS NOT NULL AND completion_evidence_digest IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS public.finance_close_events (
  id                                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                         uuid NOT NULL,
  finance_close_cycle_id            uuid NOT NULL,
  action                            text NOT NULL,
  previous_state                    text NOT NULL,
  next_state                        text NOT NULL,
  expected_revision                 bigint NOT NULL CHECK (expected_revision >= 0),
  resulting_revision                bigint NOT NULL CHECK (resulting_revision > 0),
  actor_type                        text NOT NULL
                                    CHECK (actor_type IN ('human', 'service', 'system')),
  actor_id                          text,
  authority_tier                    text NOT NULL
                                    CHECK (authority_tier IN ('system', 'finance_operator', 'owner')),
  evidence                          jsonb NOT NULL,
  evidence_digest                   text NOT NULL CHECK (evidence_digest ~ '^[a-f0-9]{64}$'),
  reconciliation_record_ids         uuid[] NOT NULL DEFAULT '{}'::uuid[],
  target_id                         uuid,
  request_fingerprint               text NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  semantic_fingerprint              text NOT NULL CHECK (semantic_fingerprint ~ '^[a-f0-9]{64}$'),
  idempotency_key                   text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  created_at                        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (finance_close_cycle_id, tenant_id)
    REFERENCES public.finance_close_cycles(id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_finance_close_cycles_tenant_period
  ON public.finance_close_cycles (tenant_id, period_start DESC, currency);
CREATE INDEX IF NOT EXISTS idx_finance_close_exceptions_open
  ON public.finance_close_exceptions (tenant_id, finance_close_cycle_id, due_at)
  WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_finance_close_tasks_due
  ON public.finance_close_tasks (tenant_id, status, due_at)
  WHERE status <> 'completed';
CREATE INDEX IF NOT EXISTS idx_finance_close_events_history
  ON public.finance_close_events
    (tenant_id, finance_close_cycle_id, created_at, id);

CREATE OR REPLACE FUNCTION public.finance_close_immutable_event()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'finance_close_evidence_is_immutable';
END;
$$;

DROP TRIGGER IF EXISTS trg_finance_close_events_immutable
  ON public.finance_close_events;
CREATE TRIGGER trg_finance_close_events_immutable
  BEFORE UPDATE OR DELETE ON public.finance_close_events
  FOR EACH ROW EXECUTE FUNCTION public.finance_close_immutable_event();

CREATE OR REPLACE FUNCTION public.finance_close_cycle_tenant_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_TABLE_NAME = 'finance_close_exceptions' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.tenant_users tenant_user
       WHERE tenant_user.tenant_id = NEW.tenant_id
         AND tenant_user.user_id = NEW.owner_id
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'finance_close_exception_owner_tenant_mismatch';
    END IF;
  ELSIF TG_TABLE_NAME = 'finance_close_tasks' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.tenant_users tenant_user
       WHERE tenant_user.tenant_id = NEW.tenant_id
         AND tenant_user.user_id = NEW.assignee_id
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'finance_close_task_assignee_tenant_mismatch';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.finance_close_automation_guard()
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
      MESSAGE = 'finance_close_kill_switch_is_one_way';
  END IF;
  IF NEW.enabled = true AND (
    NEW.execution_mode NOT IN ('shadow', 'supervised')
    OR NEW.kill_switch_engaged IS DISTINCT FROM false
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
      ERRCODE = '42501',
      MESSAGE = 'finance_close_activation_invalid';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_finance_close_automation_guard
  ON public.finance_close_automation_controls;
CREATE TRIGGER trg_finance_close_automation_guard
  BEFORE INSERT OR UPDATE ON public.finance_close_automation_controls
  FOR EACH ROW EXECUTE FUNCTION public.finance_close_automation_guard();

DROP TRIGGER IF EXISTS trg_finance_close_exceptions_tenant_guard
  ON public.finance_close_exceptions;
CREATE TRIGGER trg_finance_close_exceptions_tenant_guard
  BEFORE INSERT OR UPDATE ON public.finance_close_exceptions
  FOR EACH ROW EXECUTE FUNCTION public.finance_close_cycle_tenant_guard();

DROP TRIGGER IF EXISTS trg_finance_close_tasks_tenant_guard
  ON public.finance_close_tasks;
CREATE TRIGGER trg_finance_close_tasks_tenant_guard
  BEFORE INSERT OR UPDATE ON public.finance_close_tasks
  FOR EACH ROW EXECUTE FUNCTION public.finance_close_cycle_tenant_guard();

ALTER TABLE public.finance_close_automation_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_close_cycles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_close_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_close_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_close_events ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'finance_close_automation_controls',
    'finance_close_cycles',
    'finance_close_exceptions',
    'finance_close_tasks',
    'finance_close_events'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I',
      'tenant_iso_' || table_name, table_name);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated ' ||
      'USING (' ||
        'tenant_id = NULLIF(auth.jwt()->''app_metadata''->>''tenant_id'', '''')::uuid ' ||
        'AND auth.jwt()->''app_metadata''->>''role'' IN (' ||
          '''owner'', ''platform_owner'', ''founder'', ''admin'', ' ||
          '''client_owner'', ''tenant_owner'', ''finance''' ||
        ')' ||
      ')',
      'tenant_iso_' || table_name,
      table_name
    );
  END LOOP;
END $$;

GRANT SELECT ON
  public.finance_close_automation_controls,
  public.finance_close_cycles,
  public.finance_close_exceptions,
  public.finance_close_tasks,
  public.finance_close_events
TO authenticated, service_role;
REVOKE INSERT, UPDATE, DELETE ON
  public.finance_close_automation_controls,
  public.finance_close_cycles,
  public.finance_close_exceptions,
  public.finance_close_tasks,
  public.finance_close_events
FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.finance_close_command_rpc(
  p_tenant_id uuid,
  p_cycle_id uuid,
  p_period_start date,
  p_currency text,
  p_action text,
  p_expected_revision bigint,
  p_idempotency_key text,
  p_request_fingerprint text,
  p_actor_type text,
  p_actor_id text,
  p_authority_tier text,
  p_evidence jsonb,
  p_feature_gate_enabled boolean DEFAULT false,
  p_target_id uuid DEFAULT NULL,
  p_exception_code text DEFAULT NULL,
  p_assignee_id uuid DEFAULT NULL,
  p_due_at timestamptz DEFAULT NULL,
  p_reconciliation_record_ids uuid[] DEFAULT '{}'::uuid[]
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_claims text;
  v_calling_role text;
  v_automation public.finance_close_automation_controls%ROWTYPE;
  v_cycle public.finance_close_cycles%ROWTYPE;
  v_event public.finance_close_events%ROWTYPE;
  v_existing_event public.finance_close_events%ROWTYPE;
  v_task public.finance_close_tasks%ROWTYPE;
  v_exception public.finance_close_exceptions%ROWTYPE;
  v_previous_state text;
  v_next_state text;
  v_evidence_observed_at timestamptz;
  v_evidence_digest text;
  v_semantic_fingerprint text;
  v_actor_uuid uuid;
  v_record_count integer;
  v_bad_record_count integer;
  v_distinct_record_count integer;
  v_existing_production_lock boolean := false;
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
      MESSAGE = 'finance_close_requires_service_role';
  END IF;
  IF p_feature_gate_enabled IS DISTINCT FROM true THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'finance_close_writes_disabled';
  END IF;
  IF p_tenant_id IS NULL OR p_cycle_id IS NULL
     OR p_period_start IS NULL OR p_currency IS NULL THEN
    RAISE EXCEPTION 'finance_close_identity_required';
  END IF;
  IF p_period_start IS DISTINCT FROM date_trunc('month', p_period_start)::date
     OR p_currency !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'finance_close_period_or_currency_invalid';
  END IF;
  IF p_action NOT IN (
    'begin_close', 'raise_exception', 'accept_task', 'escalate_task',
    'complete_task', 'record_reconciliation', 'reviewer_approve',
    'sign_off', 'record_export', 'record_shadow_lock'
  ) THEN
    RAISE EXCEPTION 'finance_close_action_invalid';
  END IF;
  IF p_expected_revision IS NULL OR p_expected_revision < 0 THEN
    RAISE EXCEPTION 'finance_close_revision_invalid';
  END IF;
  IF char_length(btrim(COALESCE(p_idempotency_key, ''))) NOT BETWEEN 8 AND 200
     OR p_request_fingerprint !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'finance_close_idempotency_invalid';
  END IF;
  IF jsonb_typeof(COALESCE(p_evidence, 'null'::jsonb)) <> 'object'
     OR p_evidence = '{}'::jsonb
     OR char_length(btrim(COALESCE(p_evidence->>'source_type', ''))) NOT BETWEEN 3 AND 60
     OR char_length(btrim(COALESCE(p_evidence->>'source_id', ''))) NOT BETWEEN 3 AND 240
     OR char_length(btrim(COALESCE(p_evidence->>'observed_at', ''))) = 0 THEN
    RAISE EXCEPTION 'finance_close_evidence_invalid';
  END IF;
  BEGIN
    v_evidence_observed_at := (p_evidence->>'observed_at')::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'finance_close_evidence_time_invalid';
  END;
  IF v_evidence_observed_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'finance_close_evidence_from_future';
  END IF;

  IF p_actor_type NOT IN ('human', 'service', 'system')
     OR p_authority_tier NOT IN ('system', 'finance_operator', 'owner') THEN
    RAISE EXCEPTION 'finance_close_actor_invalid';
  END IF;
  IF p_actor_type = 'system' THEN
    IF p_actor_id IS NOT NULL OR p_authority_tier <> 'system' THEN
      RAISE EXCEPTION 'finance_close_system_actor_invalid';
    END IF;
  ELSIF p_actor_type = 'service' THEN
    IF char_length(btrim(COALESCE(p_actor_id, ''))) NOT BETWEEN 2 AND 160
       OR p_authority_tier NOT IN ('system', 'finance_operator') THEN
      RAISE EXCEPTION 'finance_close_service_actor_invalid';
    END IF;
  ELSE
    IF p_actor_id !~
      '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
      OR p_authority_tier NOT IN ('finance_operator', 'owner') THEN
      RAISE EXCEPTION 'finance_close_human_actor_invalid';
    END IF;
    v_actor_uuid := p_actor_id::uuid;
    IF NOT EXISTS (
      SELECT 1 FROM public.tenant_users tenant_user
       WHERE tenant_user.tenant_id = p_tenant_id
         AND tenant_user.user_id = v_actor_uuid
         AND tenant_user.role IN (
           'owner', 'platform_owner', 'founder', 'admin',
           'client_owner', 'tenant_owner', 'finance'
         )
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'finance_close_human_not_tenant_member';
    END IF;
  END IF;

  SELECT control.* INTO v_automation
    FROM public.finance_close_automation_controls control
   WHERE control.tenant_id = p_tenant_id
   FOR SHARE;
  IF NOT FOUND
     OR v_automation.enabled IS DISTINCT FROM true
     OR v_automation.execution_mode NOT IN ('shadow', 'supervised') THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'finance_close_tenant_not_enabled';
  END IF;
  IF v_automation.kill_switch_engaged IS DISTINCT FROM false THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'finance_close_kill_switch_engaged';
  END IF;
  IF v_automation.provider_export_enabled IS DISTINCT FROM false
     OR v_automation.production_period_lock_enabled IS DISTINCT FROM false THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'finance_close_external_mutation_forbidden';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      p_tenant_id::text || ':finance-close:' || p_period_start::text || ':' || p_currency,
      0
    )
  );

  v_evidence_digest := encode(digest(p_evidence::text, 'sha256'), 'hex');
  v_semantic_fingerprint := encode(digest(
    concat_ws('|',
      p_tenant_id::text, p_cycle_id::text, p_period_start::text, p_currency,
      p_action, p_expected_revision::text, COALESCE(p_target_id::text, ''),
      COALESCE(p_exception_code, ''), COALESCE(p_assignee_id::text, ''),
      COALESCE(p_due_at::text, ''), p_actor_type, COALESCE(p_actor_id, ''),
      p_authority_tier, p_evidence::text,
      array_to_string(p_reconciliation_record_ids, ',')
    ),
    'sha256'
  ), 'hex');

  SELECT event.* INTO v_existing_event
    FROM public.finance_close_events event
   WHERE event.tenant_id = p_tenant_id
     AND event.idempotency_key = btrim(p_idempotency_key);
  IF FOUND THEN
    IF v_existing_event.finance_close_cycle_id IS DISTINCT FROM p_cycle_id
       OR v_existing_event.action IS DISTINCT FROM p_action
       OR v_existing_event.request_fingerprint IS DISTINCT FROM p_request_fingerprint
       OR v_existing_event.semantic_fingerprint IS DISTINCT FROM v_semantic_fingerprint THEN
      RAISE EXCEPTION USING
        ERRCODE = '23505',
        MESSAGE = 'finance_close_idempotency_conflict';
    END IF;
    SELECT cycle.* INTO STRICT v_cycle
      FROM public.finance_close_cycles cycle
     WHERE cycle.id = p_cycle_id AND cycle.tenant_id = p_tenant_id;
    RETURN jsonb_build_object(
      'outcome', 'replay',
      'cycle', to_jsonb(v_cycle),
      'event', to_jsonb(v_existing_event)
    );
  END IF;

  IF p_action = 'begin_close' THEN
    IF p_expected_revision <> 0
       OR p_evidence->>'source_type' <> 'period_open_attestation' THEN
      RAISE EXCEPTION 'finance_close_begin_invalid';
    END IF;
    INSERT INTO public.finance_close_cycles (
      id, tenant_id, period_start, currency, close_state
    ) VALUES (
      p_cycle_id, p_tenant_id, p_period_start, p_currency, 'not_started'
    )
    ON CONFLICT (id) DO NOTHING;
  END IF;

  SELECT cycle.* INTO v_cycle
    FROM public.finance_close_cycles cycle
   WHERE cycle.id = p_cycle_id
     AND cycle.tenant_id = p_tenant_id
     AND cycle.period_start = p_period_start
     AND cycle.currency = p_currency
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'finance_close_cycle_not_found_for_identity';
  END IF;
  IF v_cycle.revision IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'finance_close_revision_conflict';
  END IF;
  IF v_evidence_observed_at < v_cycle.created_at - interval '5 minutes' THEN
    RAISE EXCEPTION 'finance_close_evidence_predates_cycle';
  END IF;

  v_previous_state := v_cycle.close_state;
  v_next_state := v_previous_state;

  CASE p_action
    WHEN 'begin_close' THEN
      IF v_previous_state <> 'not_started' THEN
        RAISE EXCEPTION 'finance_close_transition_invalid';
      END IF;
      v_next_state := 'reconciling';

    WHEN 'raise_exception' THEN
      IF v_previous_state NOT IN ('reconciling', 'review_ready')
         OR p_target_id IS NULL OR p_assignee_id IS NULL OR p_due_at IS NULL
         OR p_due_at <= v_evidence_observed_at
         OR p_exception_code !~ '^[a-z][a-z0-9_]{2,79}$'
         OR p_evidence->>'source_type' NOT IN (
           'reconciliation_exception', 'operator_exception'
         ) THEN
        RAISE EXCEPTION 'finance_close_exception_invalid';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM public.tenant_users tenant_user
         WHERE tenant_user.tenant_id = p_tenant_id
           AND tenant_user.user_id = p_assignee_id
      ) THEN
        RAISE EXCEPTION 'finance_close_exception_assignee_tenant_mismatch';
      END IF;
      INSERT INTO public.finance_close_exceptions (
        id, tenant_id, finance_close_cycle_id, exception_code,
        owner_id, due_at
      ) VALUES (
        p_target_id, p_tenant_id, p_cycle_id, p_exception_code,
        p_assignee_id, p_due_at
      );
      INSERT INTO public.finance_close_tasks (
        id, tenant_id, finance_close_cycle_id, finance_close_exception_id,
        task_type, assignee_id, due_at
      ) VALUES (
        gen_random_uuid(), p_tenant_id, p_cycle_id, p_target_id,
        'exception_resolution', p_assignee_id, p_due_at
      );
      v_next_state := 'exception_review';

    WHEN 'accept_task' THEN
      SELECT task.* INTO v_task
        FROM public.finance_close_tasks task
       WHERE task.id = p_target_id
         AND task.tenant_id = p_tenant_id
         AND task.finance_close_cycle_id = p_cycle_id
       FOR UPDATE;
      IF NOT FOUND OR v_task.status <> 'assigned'
         OR p_actor_type <> 'human'
         OR v_task.assignee_id IS DISTINCT FROM v_actor_uuid THEN
        RAISE EXCEPTION 'finance_close_task_acceptance_invalid';
      END IF;
      UPDATE public.finance_close_tasks
         SET status = 'accepted', accepted_at = now()
       WHERE id = v_task.id AND tenant_id = p_tenant_id;

    WHEN 'escalate_task' THEN
      SELECT task.* INTO v_task
        FROM public.finance_close_tasks task
       WHERE task.id = p_target_id
         AND task.tenant_id = p_tenant_id
         AND task.finance_close_cycle_id = p_cycle_id
       FOR UPDATE;
      IF NOT FOUND OR v_task.status NOT IN ('assigned', 'accepted')
         OR p_evidence->>'source_type' NOT IN ('sla_breach', 'operator_escalation')
         OR char_length(btrim(COALESCE(p_exception_code, ''))) NOT BETWEEN 3 AND 80 THEN
        RAISE EXCEPTION 'finance_close_task_escalation_invalid';
      END IF;
      UPDATE public.finance_close_tasks
         SET status = 'escalated',
             escalated_at = now(),
             escalation_code = btrim(p_exception_code)
       WHERE id = v_task.id AND tenant_id = p_tenant_id;

    WHEN 'complete_task' THEN
      SELECT task.* INTO v_task
        FROM public.finance_close_tasks task
       WHERE task.id = p_target_id
         AND task.tenant_id = p_tenant_id
         AND task.finance_close_cycle_id = p_cycle_id
       FOR UPDATE;
      IF NOT FOUND OR v_task.status NOT IN ('accepted', 'escalated')
         OR p_actor_type <> 'human'
         OR (
           v_task.assignee_id IS DISTINCT FROM v_actor_uuid
           AND p_authority_tier <> 'owner'
         )
         OR p_evidence->>'source_type' <> 'task_completion_receipt' THEN
        RAISE EXCEPTION 'finance_close_task_completion_invalid';
      END IF;
      UPDATE public.finance_close_tasks
         SET status = 'completed',
             accepted_at = COALESCE(accepted_at, now()),
             completed_at = now(),
             completion_evidence_digest = v_evidence_digest
       WHERE id = v_task.id AND tenant_id = p_tenant_id;
      IF v_task.finance_close_exception_id IS NOT NULL THEN
        UPDATE public.finance_close_exceptions
           SET status = 'resolved',
               resolved_at = now(),
               resolution_evidence_digest = v_evidence_digest
         WHERE id = v_task.finance_close_exception_id
           AND tenant_id = p_tenant_id
           AND status = 'open';
        IF NOT EXISTS (
          SELECT 1 FROM public.finance_close_exceptions exception
           WHERE exception.tenant_id = p_tenant_id
             AND exception.finance_close_cycle_id = p_cycle_id
             AND exception.status = 'open'
        ) THEN
          v_next_state := 'reconciling';
        END IF;
      END IF;

    WHEN 'record_reconciliation' THEN
      IF v_previous_state <> 'reconciling'
         OR p_evidence->>'source_type' <> 'finance_attribution_manifest'
         OR cardinality(p_reconciliation_record_ids) = 0 THEN
        RAISE EXCEPTION 'finance_close_reconciliation_invalid';
      END IF;
      SELECT count(*), count(DISTINCT record_id)
        INTO v_record_count, v_distinct_record_count
        FROM unnest(p_reconciliation_record_ids) AS record_id;
      SELECT count(*) INTO v_bad_record_count
        FROM unnest(p_reconciliation_record_ids) AS manifest(record_id)
        LEFT JOIN public.finance_attribution_records attribution
          ON attribution.id = manifest.record_id
         AND attribution.tenant_id = p_tenant_id
         AND attribution.currency = p_currency
         AND attribution.occurred_on >= p_period_start
         AND attribution.occurred_on < (p_period_start + interval '1 month')::date
         AND attribution.reconciliation_status = 'matched'
       WHERE attribution.id IS NULL;
      IF v_record_count <> v_distinct_record_count OR v_bad_record_count <> 0
         OR EXISTS (
           SELECT 1 FROM public.finance_close_exceptions exception
            WHERE exception.tenant_id = p_tenant_id
              AND exception.finance_close_cycle_id = p_cycle_id
              AND exception.status = 'open'
         )
         OR EXISTS (
           SELECT 1 FROM public.finance_close_tasks task
            WHERE task.tenant_id = p_tenant_id
              AND task.finance_close_cycle_id = p_cycle_id
              AND task.status <> 'completed'
         ) THEN
        RAISE EXCEPTION 'finance_close_reconciliation_prerequisites_unmet';
      END IF;
      v_next_state := 'review_ready';
      UPDATE public.finance_close_cycles
         SET reconciliation_manifest_digest = v_evidence_digest,
             reconciliation_record_count = v_record_count
       WHERE id = p_cycle_id AND tenant_id = p_tenant_id;

    WHEN 'reviewer_approve' THEN
      IF v_previous_state <> 'review_ready'
         OR p_actor_type <> 'human'
         OR p_evidence->>'source_type' <> 'reviewer_decision'
         OR v_cycle.reconciliation_manifest_digest IS NULL THEN
        RAISE EXCEPTION 'finance_close_review_invalid';
      END IF;
      v_next_state := 'reviewer_approved';
      UPDATE public.finance_close_cycles
         SET reviewer_id = v_actor_uuid, reviewed_at = now()
       WHERE id = p_cycle_id AND tenant_id = p_tenant_id;

    WHEN 'sign_off' THEN
      IF v_previous_state <> 'reviewer_approved'
         OR p_actor_type <> 'human'
         OR p_authority_tier <> 'owner'
         OR p_evidence->>'source_type' <> 'signoff_decision'
         OR v_cycle.reviewer_id IS NULL
         OR v_cycle.reviewer_id = v_actor_uuid THEN
        RAISE EXCEPTION 'finance_close_signoff_invalid';
      END IF;
      v_next_state := 'signed_off';
      UPDATE public.finance_close_cycles
         SET signatory_id = v_actor_uuid, signed_off_at = now()
       WHERE id = p_cycle_id AND tenant_id = p_tenant_id;

    WHEN 'record_export' THEN
      IF v_previous_state <> 'signed_off'
         OR p_evidence->>'source_type' <> 'export_artifact_receipt'
         OR NULLIF(p_evidence->>'artifact_id', '') IS NULL THEN
        RAISE EXCEPTION 'finance_close_export_invalid';
      END IF;
      v_next_state := 'exported';
      UPDATE public.finance_close_cycles
         SET export_receipt_digest = v_evidence_digest, exported_at = now()
       WHERE id = p_cycle_id AND tenant_id = p_tenant_id;

    WHEN 'record_shadow_lock' THEN
      IF to_regclass('public.finance_period_locks') IS NOT NULL THEN
        EXECUTE
          'SELECT EXISTS (
             SELECT 1
               FROM public.finance_period_locks
              WHERE tenant_id = $1
                AND year = EXTRACT(YEAR FROM $2::date)::integer
                AND month = EXTRACT(MONTH FROM $2::date)::integer
                AND reopened_at IS NULL
           )'
          INTO v_existing_production_lock
          USING p_tenant_id, p_period_start;
      END IF;
      IF v_previous_state <> 'exported'
         OR p_actor_type <> 'human'
         OR p_authority_tier <> 'owner'
         OR p_evidence->>'source_type' <> 'shadow_lock_decision'
         OR v_existing_production_lock THEN
        RAISE EXCEPTION 'finance_close_shadow_lock_invalid';
      END IF;
      v_next_state := 'shadow_locked';
      UPDATE public.finance_close_cycles
         SET shadow_lock_evidence_digest = v_evidence_digest,
             shadow_locked_at = now()
       WHERE id = p_cycle_id AND tenant_id = p_tenant_id;
  END CASE;

  UPDATE public.finance_close_cycles
     SET close_state = v_next_state,
         revision = revision + 1,
         last_action_at = now(),
         updated_at = now()
   WHERE id = p_cycle_id AND tenant_id = p_tenant_id
  RETURNING * INTO v_cycle;

  INSERT INTO public.finance_close_events (
    tenant_id, finance_close_cycle_id, action, previous_state, next_state,
    expected_revision, resulting_revision, actor_type, actor_id,
    authority_tier, evidence, evidence_digest, reconciliation_record_ids,
    target_id, request_fingerprint, semantic_fingerprint, idempotency_key
  ) VALUES (
    p_tenant_id, p_cycle_id, p_action, v_previous_state, v_next_state,
    p_expected_revision, v_cycle.revision, p_actor_type, p_actor_id,
    p_authority_tier, p_evidence, v_evidence_digest,
    p_reconciliation_record_ids, p_target_id, p_request_fingerprint,
    v_semantic_fingerprint, btrim(p_idempotency_key)
  )
  RETURNING * INTO v_event;

  RETURN jsonb_build_object(
    'outcome', 'applied',
    'cycle', to_jsonb(v_cycle),
    'event', to_jsonb(v_event)
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.finance_close_command_rpc(
  uuid, uuid, date, text, text, bigint, text, text, text, text, text,
  jsonb, boolean, uuid, text, uuid, timestamptz, uuid[]
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finance_close_command_rpc(
  uuid, uuid, date, text, text, bigint, text, text, text, text, text,
  jsonb, boolean, uuid, text, uuid, timestamptz, uuid[]
) TO service_role;

CREATE OR REPLACE FUNCTION public.finance_close_kill_switch_rpc(
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
  v_control public.finance_close_automation_controls%ROWTYPE;
BEGIN
  v_claims := NULLIF(current_setting('request.jwt.claims', true), '');
  v_calling_role := COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    CASE WHEN v_claims IS NOT NULL THEN v_claims::jsonb ->> 'role' END,
    session_user::text
  );
  IF v_calling_role IS DISTINCT FROM 'service_role'
     OR char_length(btrim(COALESCE(p_reason, ''))) NOT BETWEEN 3 AND 240 THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'finance_close_kill_switch_denied';
  END IF;
  UPDATE public.finance_close_automation_controls
     SET kill_switch_engaged = true,
         revision = revision + 1,
         updated_at = now()
   WHERE tenant_id = p_tenant_id
  RETURNING * INTO v_control;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'finance_close_control_not_found';
  END IF;
  RETURN jsonb_build_object(
    'outcome', 'kill_switch_engaged',
    'tenant_id', v_control.tenant_id,
    'revision', v_control.revision,
    'reason_digest', encode(digest(btrim(p_reason), 'sha256'), 'hex')
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.finance_close_kill_switch_rpc(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finance_close_kill_switch_rpc(uuid, text)
  TO service_role;
