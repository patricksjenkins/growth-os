-- ============================================================================
-- Migration 086: Supervised Revenue and Sales Department Head foundation
-- Date: 2026-07-24
--
-- Additive, default-off, evidence-only department control. This migration
-- cannot send outreach, call a provider, mutate leads, change pricing, create
-- contracts, or move money. It accepts structured funnel reports and allows a
-- registered Revenue Head to coordinate only within its supervised ledger.
--
-- ROLLBACK: db/rollbacks/086_revenue_department_head_supervised_rollback.sql
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.revenue_head_controls (
  tenant_id                    uuid PRIMARY KEY
                               REFERENCES public.tenants(id) ON DELETE CASCADE,
  enabled                      boolean NOT NULL DEFAULT false,
  execution_mode               text NOT NULL DEFAULT 'disabled'
                               CHECK (execution_mode IN (
                                 'disabled', 'supervised_read_only'
                               )),
  kill_switch_engaged          boolean NOT NULL DEFAULT true,
  registered_agent_id          text
                               CHECK (
                                 registered_agent_id IS NULL
                                 OR char_length(btrim(registered_agent_id))
                                    BETWEEN 2 AND 160
                               ),
  production_write_authority   boolean NOT NULL DEFAULT false
                               CHECK (production_write_authority = false),
  outreach_enabled             boolean NOT NULL DEFAULT false
                               CHECK (outreach_enabled = false),
  provider_dispatch_enabled    boolean NOT NULL DEFAULT false
                               CHECK (provider_dispatch_enabled = false),
  pricing_authority_enabled    boolean NOT NULL DEFAULT false
                               CHECK (pricing_authority_enabled = false),
  financial_authority_enabled  boolean NOT NULL DEFAULT false
                               CHECK (financial_authority_enabled = false),
  revision                     bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  activated_by                 uuid,
  activation_evidence          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.revenue_head_charters (
  id                               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                        uuid NOT NULL
                                   REFERENCES public.tenants(id) ON DELETE RESTRICT,
  version                          integer NOT NULL CHECK (version > 0),
  mission                          text NOT NULL
                                   CHECK (char_length(btrim(mission)) BETWEEN 40 AND 1000),
  qualification_rate_target_bps    integer NOT NULL
                                   CHECK (qualification_rate_target_bps BETWEEN 1 AND 10000),
  appointment_rate_target_bps      integer NOT NULL
                                   CHECK (appointment_rate_target_bps BETWEEN 1 AND 10000),
  held_rate_target_bps             integer NOT NULL
                                   CHECK (held_rate_target_bps BETWEEN 1 AND 10000),
  proposal_rate_target_bps         integer NOT NULL
                                   CHECK (proposal_rate_target_bps BETWEEN 1 AND 10000),
  win_rate_target_bps              integer NOT NULL
                                   CHECK (win_rate_target_bps BETWEEN 1 AND 10000),
  max_sales_cycle_days             integer NOT NULL
                                   CHECK (max_sales_cycle_days BETWEEN 1 AND 3650),
  evidence                         jsonb NOT NULL,
  evidence_digest                  text NOT NULL
                                   CHECK (evidence_digest ~ '^[a-f0-9]{64}$'),
  actor_id                         uuid NOT NULL,
  idempotency_key                  text NOT NULL
                                   CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  request_fingerprint              text NOT NULL
                                   CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  created_at                       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, version),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS public.revenue_head_reports (
  id                               uuid PRIMARY KEY,
  tenant_id                        uuid NOT NULL
                                   REFERENCES public.tenants(id) ON DELETE RESTRICT,
  charter_id                       uuid NOT NULL,
  schema_version                   integer NOT NULL DEFAULT 1
                                   CHECK (schema_version = 1),
  report_type                      text NOT NULL DEFAULT 'sales_outcome_v1'
                                   CHECK (report_type = 'sales_outcome_v1'),
  period_start                     date NOT NULL,
  period_end                       date NOT NULL,
  source_system                    text NOT NULL
                                   CHECK (source_system ~ '^[a-z][a-z0-9_]{1,63}$'),
  source_report_id                 text NOT NULL
                                   CHECK (
                                     char_length(source_report_id) BETWEEN 2 AND 240
                                     AND source_report_id ~
                                       '^[A-Za-z0-9][A-Za-z0-9._:/-]{1,239}$'
                                   ),
  leads_created                    integer NOT NULL CHECK (leads_created >= 0),
  qualified_leads                  integer NOT NULL CHECK (qualified_leads >= 0),
  appointments_booked              integer NOT NULL CHECK (appointments_booked >= 0),
  appointments_held                integer NOT NULL CHECK (appointments_held >= 0),
  proposals_sent                   integer NOT NULL CHECK (proposals_sent >= 0),
  closed_won                       integer NOT NULL CHECK (closed_won >= 0),
  closed_lost                      integer NOT NULL CHECK (closed_lost >= 0),
  open_pipeline_minor              bigint NOT NULL CHECK (open_pipeline_minor >= 0),
  booked_revenue_minor             bigint NOT NULL CHECK (booked_revenue_minor >= 0),
  currency                         text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  average_sales_cycle_days         numeric(8,3) NOT NULL
                                   CHECK (
                                     average_sales_cycle_days BETWEEN 0 AND 3650
                                   ),
  qualification_rate_bps           integer,
  appointment_rate_bps             integer,
  held_rate_bps                    integer,
  proposal_rate_bps                integer,
  win_rate_bps                     integer,
  funnel_health                    text NOT NULL
                                   CHECK (funnel_health IN (
                                     'healthy', 'at_risk', 'critical', 'unverified'
                                   )),
  business_effect_state            text NOT NULL
                                   CHECK (business_effect_state IN (
                                     'observed', 'unverified'
                                   )),
  outcome_healthy                  boolean GENERATED ALWAYS AS (
                                     funnel_health = 'healthy'
                                     AND business_effect_state = 'observed'
                                   ) STORED,
  evidence                         jsonb NOT NULL,
  evidence_count                   integer NOT NULL CHECK (evidence_count > 0),
  evidence_digest                  text NOT NULL
                                   CHECK (evidence_digest ~ '^[a-f0-9]{64}$'),
  accepted_at                      timestamptz NOT NULL DEFAULT now(),
  idempotency_key                  text NOT NULL
                                   CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  request_fingerprint              text NOT NULL
                                   CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  created_at                       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (source_system, source_report_id),
  FOREIGN KEY (charter_id, tenant_id)
    REFERENCES public.revenue_head_charters(id, tenant_id) ON DELETE RESTRICT,
  CHECK (period_end >= period_start),
  CHECK (
    qualified_leads <= leads_created
    AND appointments_booked <= qualified_leads
    AND appointments_held <= appointments_booked
    AND proposals_sent <= appointments_held
    AND closed_won + closed_lost <= proposals_sent
  ),
  CHECK (
    (leads_created = 0 AND qualification_rate_bps IS NULL)
    OR (leads_created > 0 AND qualification_rate_bps BETWEEN 0 AND 10000)
  ),
  CHECK (
    (qualified_leads = 0 AND appointment_rate_bps IS NULL)
    OR (qualified_leads > 0 AND appointment_rate_bps BETWEEN 0 AND 10000)
  ),
  CHECK (
    (appointments_booked = 0 AND held_rate_bps IS NULL)
    OR (appointments_booked > 0 AND held_rate_bps BETWEEN 0 AND 10000)
  ),
  CHECK (
    (appointments_held = 0 AND proposal_rate_bps IS NULL)
    OR (appointments_held > 0 AND proposal_rate_bps BETWEEN 0 AND 10000)
  ),
  CHECK (
    (
      closed_won + closed_lost = 0
      AND win_rate_bps IS NULL
      AND business_effect_state = 'unverified'
    )
    OR (
      closed_won + closed_lost > 0
      AND win_rate_bps BETWEEN 0 AND 10000
    )
  )
);

CREATE TABLE IF NOT EXISTS public.revenue_head_items (
  id                               uuid PRIMARY KEY,
  tenant_id                        uuid NOT NULL
                                   REFERENCES public.tenants(id) ON DELETE RESTRICT,
  report_id                        uuid NOT NULL,
  item_kind                        text NOT NULL
                                   CHECK (item_kind IN (
                                     'goal', 'work', 'decision', 'exception'
                                   )),
  action_scope                     text NOT NULL
                                   CHECK (action_scope IN (
                                     'analyze_funnel', 'track_goal',
                                     'recommend_action', 'request_owner_decision',
                                     'raise_exception', 'verify_evidence'
                                   )),
  title                            text NOT NULL
                                   CHECK (char_length(btrim(title)) BETWEEN 3 AND 240),
  status                           text NOT NULL DEFAULT 'assigned'
                                   CHECK (status IN (
                                     'assigned', 'accepted', 'in_progress',
                                     'escalated', 'completed'
                                   )),
  revision                         bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  assignee_type                    text NOT NULL
                                   CHECK (assignee_type IN ('agent', 'human')),
  assignee_id                      text NOT NULL
                                   CHECK (char_length(btrim(assignee_id)) BETWEEN 2 AND 160),
  assigned_at                      timestamptz NOT NULL DEFAULT now(),
  accepted_at                      timestamptz,
  started_at                       timestamptz,
  due_at                           timestamptz NOT NULL,
  escalated_at                     timestamptz,
  escalation_code                  text
                                   CHECK (
                                     escalation_code IS NULL
                                     OR escalation_code ~ '^[a-z][a-z0-9_]{1,63}$'
                                   ),
  completed_at                     timestamptz,
  completion_evidence_digest       text
                                   CHECK (
                                     completion_evidence_digest IS NULL
                                     OR completion_evidence_digest ~ '^[a-f0-9]{64}$'
                                   ),
  decision_state                   text NOT NULL DEFAULT 'not_applicable'
                                   CHECK (decision_state IN (
                                     'not_applicable', 'pending',
                                     'approved', 'rejected'
                                   )),
  created_at                       timestamptz NOT NULL DEFAULT now(),
  updated_at                       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (report_id, tenant_id)
    REFERENCES public.revenue_head_reports(id, tenant_id) ON DELETE RESTRICT,
  CHECK (due_at >= assigned_at),
  CHECK (
    (item_kind = 'goal' AND action_scope = 'track_goal')
    OR (
      item_kind = 'decision'
      AND action_scope = 'request_owner_decision'
    )
    OR (
      item_kind = 'exception'
      AND action_scope = 'raise_exception'
    )
    OR (
      item_kind = 'work'
      AND action_scope IN (
        'analyze_funnel', 'recommend_action', 'verify_evidence'
      )
    )
  ),
  CHECK (
    (item_kind = 'decision' AND decision_state IN (
      'pending', 'approved', 'rejected'
    ))
    OR (item_kind <> 'decision' AND decision_state = 'not_applicable')
  ),
  CHECK (
    (status = 'assigned'
      AND accepted_at IS NULL AND started_at IS NULL
      AND escalated_at IS NULL AND completed_at IS NULL)
    OR
    (status = 'accepted'
      AND accepted_at IS NOT NULL AND started_at IS NULL
      AND escalated_at IS NULL AND completed_at IS NULL)
    OR
    (status = 'in_progress'
      AND accepted_at IS NOT NULL AND started_at IS NOT NULL
      AND escalated_at IS NULL AND completed_at IS NULL)
    OR
    (status = 'escalated'
      AND escalated_at IS NOT NULL AND escalation_code IS NOT NULL
      AND completed_at IS NULL)
    OR
    (status = 'completed'
      AND completed_at IS NOT NULL
      AND completion_evidence_digest IS NOT NULL)
  ),
  CHECK (
    decision_state NOT IN ('approved', 'rejected')
    OR status = 'completed'
  )
);

CREATE TABLE IF NOT EXISTS public.revenue_head_events (
  id                               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                        uuid NOT NULL,
  item_id                          uuid NOT NULL,
  report_id                        uuid NOT NULL,
  event_type                       text NOT NULL
                                   CHECK (event_type IN (
                                     'assigned', 'accepted', 'started',
                                     'escalated', 'completed', 'decision_recorded'
                                   )),
  previous_status                  text,
  resulting_status                 text NOT NULL,
  expected_revision                bigint NOT NULL CHECK (expected_revision >= 0),
  resulting_revision               bigint NOT NULL CHECK (resulting_revision > 0),
  actor_type                       text NOT NULL
                                   CHECK (actor_type IN ('agent', 'human', 'system')),
  actor_id                         text,
  authority_tier                  text NOT NULL
                                   CHECK (authority_tier IN (
                                     'system', 'department_head', 'owner'
                                   )),
  evidence                         jsonb NOT NULL,
  evidence_digest                  text NOT NULL
                                   CHECK (evidence_digest ~ '^[a-f0-9]{64}$'),
  idempotency_key                  text NOT NULL
                                   CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  request_fingerprint              text NOT NULL
                                   CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  semantic_fingerprint             text NOT NULL
                                   CHECK (semantic_fingerprint ~ '^[a-f0-9]{64}$'),
  occurred_at                      timestamptz NOT NULL DEFAULT now(),
  created_at                       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (item_id, tenant_id)
    REFERENCES public.revenue_head_items(id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (report_id, tenant_id)
    REFERENCES public.revenue_head_reports(id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_revenue_head_reports_health
  ON public.revenue_head_reports
    (tenant_id, funnel_health, period_end DESC);
CREATE INDEX IF NOT EXISTS idx_revenue_head_items_sla
  ON public.revenue_head_items (tenant_id, status, due_at)
  WHERE status <> 'completed';
CREATE INDEX IF NOT EXISTS idx_revenue_head_items_report
  ON public.revenue_head_items (tenant_id, report_id, item_kind);
CREATE INDEX IF NOT EXISTS idx_revenue_head_events_history
  ON public.revenue_head_events (tenant_id, item_id, occurred_at, id);

CREATE OR REPLACE FUNCTION public.revenue_head_immutable_row()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'revenue_head_evidence_is_immutable';
END;
$$;

DROP TRIGGER IF EXISTS trg_revenue_head_charters_immutable
  ON public.revenue_head_charters;
CREATE TRIGGER trg_revenue_head_charters_immutable
  BEFORE UPDATE OR DELETE ON public.revenue_head_charters
  FOR EACH ROW EXECUTE FUNCTION public.revenue_head_immutable_row();
DROP TRIGGER IF EXISTS trg_revenue_head_reports_immutable
  ON public.revenue_head_reports;
CREATE TRIGGER trg_revenue_head_reports_immutable
  BEFORE UPDATE OR DELETE ON public.revenue_head_reports
  FOR EACH ROW EXECUTE FUNCTION public.revenue_head_immutable_row();
DROP TRIGGER IF EXISTS trg_revenue_head_events_immutable
  ON public.revenue_head_events;
CREATE TRIGGER trg_revenue_head_events_immutable
  BEFORE UPDATE OR DELETE ON public.revenue_head_events
  FOR EACH ROW EXECUTE FUNCTION public.revenue_head_immutable_row();

CREATE OR REPLACE FUNCTION public.revenue_head_item_identity_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.report_id IS DISTINCT FROM OLD.report_id
     OR NEW.item_kind IS DISTINCT FROM OLD.item_kind
     OR NEW.action_scope IS DISTINCT FROM OLD.action_scope
     OR NEW.title IS DISTINCT FROM OLD.title
     OR NEW.assignee_type IS DISTINCT FROM OLD.assignee_type
     OR NEW.assignee_id IS DISTINCT FROM OLD.assignee_id
     OR NEW.assigned_at IS DISTINCT FROM OLD.assigned_at
     OR NEW.due_at IS DISTINCT FROM OLD.due_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'revenue_head_item_identity_is_immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_revenue_head_item_identity_guard
  ON public.revenue_head_items;
CREATE TRIGGER trg_revenue_head_item_identity_guard
  BEFORE UPDATE ON public.revenue_head_items
  FOR EACH ROW EXECUTE FUNCTION public.revenue_head_item_identity_guard();

CREATE OR REPLACE FUNCTION public.revenue_head_control_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.kill_switch_engaged = true
     AND NEW.kill_switch_engaged = false THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'revenue_head_kill_switch_is_one_way';
  END IF;
  IF NEW.production_write_authority IS DISTINCT FROM false
     OR NEW.outreach_enabled IS DISTINCT FROM false
     OR NEW.provider_dispatch_enabled IS DISTINCT FROM false
     OR NEW.pricing_authority_enabled IS DISTINCT FROM false
     OR NEW.financial_authority_enabled IS DISTINCT FROM false THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'revenue_head_production_authority_forbidden';
  END IF;
  IF NEW.enabled = true AND (
    NEW.execution_mode <> 'supervised_read_only'
    OR NEW.kill_switch_engaged IS DISTINCT FROM false
    OR char_length(btrim(COALESCE(NEW.registered_agent_id, '')))
       NOT BETWEEN 2 AND 160
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
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'revenue_head_activation_invalid';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    NEW.revision := OLD.revision + 1;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_revenue_head_control_guard
  ON public.revenue_head_controls;
CREATE TRIGGER trg_revenue_head_control_guard
  BEFORE INSERT OR UPDATE ON public.revenue_head_controls
  FOR EACH ROW EXECUTE FUNCTION public.revenue_head_control_guard();

ALTER TABLE public.revenue_head_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.revenue_head_charters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.revenue_head_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.revenue_head_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.revenue_head_events ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'revenue_head_controls',
    'revenue_head_charters',
    'revenue_head_reports',
    'revenue_head_items',
    'revenue_head_events'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I',
      'tenant_iso_' || v_table, v_table);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (' ||
      'tenant_id = NULLIF(auth.jwt()->''app_metadata''->>''tenant_id'', '''')::uuid ' ||
      'AND auth.jwt()->''app_metadata''->>''role'' IN (' ||
      '''owner'', ''platform_owner'', ''founder'', ''admin'', ' ||
      '''client_owner'', ''tenant_owner'', ''sales'', ''manager''))',
      'tenant_iso_' || v_table, v_table
    );
  END LOOP;
END $$;

GRANT SELECT ON
  public.revenue_head_controls,
  public.revenue_head_charters,
  public.revenue_head_reports,
  public.revenue_head_items,
  public.revenue_head_events
TO authenticated, service_role;
REVOKE INSERT, UPDATE, DELETE ON
  public.revenue_head_controls,
  public.revenue_head_charters,
  public.revenue_head_reports,
  public.revenue_head_items,
  public.revenue_head_events
FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.revenue_head_evidence_digest(
  p_evidence jsonb
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_source jsonb;
BEGIN
  IF jsonb_typeof(COALESCE(p_evidence, 'null'::jsonb)) <> 'object'
     OR p_evidence->>'schema_version' <> '1'
     OR jsonb_typeof(p_evidence->'sources') <> 'array'
     OR jsonb_array_length(p_evidence->'sources') NOT BETWEEN 1 AND 50
     OR p_evidence::text ~* (
       '"(email|phone|recipient|message|body|send|dispatch|provider|'
       'provider_payload|providerPayload|provider_token|providerToken|'
       'price|pricing|charge|refund|contract|customer_name|customerName)"'
       '[[:space:]]*:'
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'revenue_head_evidence_contract_invalid';
  END IF;
  FOR v_source IN
    SELECT value FROM jsonb_array_elements(p_evidence->'sources')
  LOOP
    IF jsonb_typeof(v_source) <> 'object'
       OR v_source->>'source_type' !~ '^[a-z][a-z0-9_]{1,63}$'
       OR char_length(COALESCE(v_source->>'source_id', '')) NOT BETWEEN 2 AND 240
       OR COALESCE(v_source->>'source_id', '') !~
          '^[A-Za-z0-9][A-Za-z0-9._:/-]{1,239}$'
       OR COALESCE(v_source->>'evidence_digest', '') !~ '^[a-f0-9]{64}$'
       OR NULLIF(v_source->>'observed_at', '') IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'revenue_head_evidence_source_invalid';
    END IF;
    BEGIN
      IF (v_source->>'observed_at')::timestamptz > now() + interval '5 minutes' THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
          MESSAGE = 'revenue_head_evidence_from_future';
      END IF;
    EXCEPTION WHEN invalid_datetime_format THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'revenue_head_evidence_time_invalid';
    END;
  END LOOP;
  IF (
    SELECT count(*) <> count(DISTINCT (
      source.value->>'source_type',
      source.value->>'source_id'
    ))
      FROM jsonb_array_elements(p_evidence->'sources') source(value)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'revenue_head_duplicate_evidence_source';
  END IF;
  RETURN encode(digest(convert_to(p_evidence::text, 'UTF8'), 'sha256'), 'hex');
END;
$$;

CREATE OR REPLACE FUNCTION public.revenue_head_assert_control(
  p_tenant_id uuid,
  p_feature_gate_enabled boolean
) RETURNS public.revenue_head_controls
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_claims text;
  v_calling_role text;
  v_control public.revenue_head_controls%ROWTYPE;
BEGIN
  v_claims := NULLIF(current_setting('request.jwt.claims', true), '');
  v_calling_role := COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    CASE WHEN v_claims IS NOT NULL THEN v_claims::jsonb ->> 'role' END,
    session_user::text
  );
  IF v_calling_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'revenue_head_requires_service_role';
  END IF;
  IF p_feature_gate_enabled IS DISTINCT FROM true THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'revenue_head_writes_disabled';
  END IF;
  SELECT control.* INTO STRICT v_control
    FROM public.revenue_head_controls control
   WHERE control.tenant_id = p_tenant_id
   FOR UPDATE;
  IF v_control.enabled IS DISTINCT FROM true
     OR v_control.execution_mode <> 'supervised_read_only'
     OR v_control.kill_switch_engaged IS DISTINCT FROM false
     OR v_control.production_write_authority IS DISTINCT FROM false
     OR v_control.outreach_enabled IS DISTINCT FROM false
     OR v_control.provider_dispatch_enabled IS DISTINCT FROM false
     OR v_control.pricing_authority_enabled IS DISTINCT FROM false
     OR v_control.financial_authority_enabled IS DISTINCT FROM false THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'revenue_head_control_not_active';
  END IF;
  RETURN v_control;
END;
$$;

CREATE OR REPLACE FUNCTION public.revenue_head_charter_register_rpc(
  p_tenant_id uuid,
  p_version integer,
  p_mission text,
  p_qualification_rate_target_bps integer,
  p_appointment_rate_target_bps integer,
  p_held_rate_target_bps integer,
  p_proposal_rate_target_bps integer,
  p_win_rate_target_bps integer,
  p_max_sales_cycle_days integer,
  p_actor_id uuid,
  p_evidence jsonb,
  p_idempotency_key text,
  p_request_fingerprint text,
  p_feature_gate_enabled boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_control public.revenue_head_controls%ROWTYPE;
  v_existing public.revenue_head_charters%ROWTYPE;
  v_charter public.revenue_head_charters%ROWTYPE;
  v_evidence_digest text;
BEGIN
  v_control := public.revenue_head_assert_control(
    p_tenant_id, p_feature_gate_enabled
  );
  IF NOT EXISTS (
    SELECT 1 FROM public.tenant_users tenant_user
     WHERE tenant_user.tenant_id = p_tenant_id
       AND tenant_user.user_id = p_actor_id
       AND tenant_user.role IN (
         'owner', 'platform_owner', 'founder', 'admin',
         'client_owner', 'tenant_owner'
       )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'revenue_head_charter_requires_tenant_owner';
  END IF;
  v_evidence_digest := public.revenue_head_evidence_digest(p_evidence);
  SELECT charter.* INTO v_existing
    FROM public.revenue_head_charters charter
   WHERE charter.tenant_id = p_tenant_id
     AND charter.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.request_fingerprint IS DISTINCT FROM p_request_fingerprint
       OR v_existing.version IS DISTINCT FROM p_version
       OR v_existing.mission IS DISTINCT FROM p_mission
       OR v_existing.qualification_rate_target_bps IS DISTINCT FROM
          p_qualification_rate_target_bps
       OR v_existing.appointment_rate_target_bps IS DISTINCT FROM
          p_appointment_rate_target_bps
       OR v_existing.held_rate_target_bps IS DISTINCT FROM
          p_held_rate_target_bps
       OR v_existing.proposal_rate_target_bps IS DISTINCT FROM
          p_proposal_rate_target_bps
       OR v_existing.win_rate_target_bps IS DISTINCT FROM
          p_win_rate_target_bps
       OR v_existing.max_sales_cycle_days IS DISTINCT FROM
          p_max_sales_cycle_days
       OR v_existing.actor_id IS DISTINCT FROM p_actor_id
       OR v_existing.evidence IS DISTINCT FROM p_evidence
       OR v_existing.evidence_digest IS DISTINCT FROM v_evidence_digest THEN
      RAISE EXCEPTION USING ERRCODE = '23505',
        MESSAGE = 'revenue_head_charter_idempotency_conflict';
    END IF;
    RETURN jsonb_build_object('outcome', 'replay', 'charter', to_jsonb(v_existing));
  END IF;
  INSERT INTO public.revenue_head_charters (
    tenant_id, version, mission, qualification_rate_target_bps,
    appointment_rate_target_bps, held_rate_target_bps,
    proposal_rate_target_bps, win_rate_target_bps, max_sales_cycle_days,
    evidence, evidence_digest, actor_id, idempotency_key, request_fingerprint
  ) VALUES (
    p_tenant_id, p_version, p_mission, p_qualification_rate_target_bps,
    p_appointment_rate_target_bps, p_held_rate_target_bps,
    p_proposal_rate_target_bps, p_win_rate_target_bps, p_max_sales_cycle_days,
    p_evidence, v_evidence_digest, p_actor_id, p_idempotency_key,
    p_request_fingerprint
  ) RETURNING * INTO v_charter;
  RETURN jsonb_build_object('outcome', 'registered', 'charter', to_jsonb(v_charter));
END;
$$;

CREATE OR REPLACE FUNCTION public.revenue_head_report_accept_rpc(
  p_tenant_id uuid,
  p_report_id uuid,
  p_charter_id uuid,
  p_period_start date,
  p_period_end date,
  p_source_system text,
  p_source_report_id text,
  p_leads_created integer,
  p_qualified_leads integer,
  p_appointments_booked integer,
  p_appointments_held integer,
  p_proposals_sent integer,
  p_closed_won integer,
  p_closed_lost integer,
  p_open_pipeline_minor bigint,
  p_booked_revenue_minor bigint,
  p_currency text,
  p_average_sales_cycle_days numeric,
  p_evidence jsonb,
  p_idempotency_key text,
  p_request_fingerprint text,
  p_feature_gate_enabled boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_control public.revenue_head_controls%ROWTYPE;
  v_charter public.revenue_head_charters%ROWTYPE;
  v_existing public.revenue_head_reports%ROWTYPE;
  v_report public.revenue_head_reports%ROWTYPE;
  v_evidence_digest text;
  v_evidence_count integer;
  v_evidence_source_type_count integer;
  v_qualification integer;
  v_appointment integer;
  v_held integer;
  v_proposal integer;
  v_win integer;
  v_health text;
  v_business text;
BEGIN
  v_control := public.revenue_head_assert_control(
    p_tenant_id, p_feature_gate_enabled
  );
  SELECT charter.* INTO STRICT v_charter
    FROM public.revenue_head_charters charter
   WHERE charter.id = p_charter_id
     AND charter.tenant_id = p_tenant_id;
  IF p_report_id IS NULL
     OR p_period_start IS NULL
     OR p_period_end < p_period_start
     OR p_source_system !~ '^[a-z][a-z0-9_]{1,63}$'
     OR char_length(p_source_report_id) NOT BETWEEN 2 AND 240
     OR p_source_report_id !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{1,239}$'
     OR p_currency !~ '^[A-Z]{3}$'
     OR p_leads_created < 0
     OR p_qualified_leads < 0
     OR p_appointments_booked < 0
     OR p_appointments_held < 0
     OR p_proposals_sent < 0
     OR p_closed_won < 0
     OR p_closed_lost < 0
     OR p_open_pipeline_minor < 0
     OR p_booked_revenue_minor < 0
     OR p_average_sales_cycle_days NOT BETWEEN 0 AND 3650
     OR p_qualified_leads > p_leads_created
     OR p_appointments_booked > p_qualified_leads
     OR p_appointments_held > p_appointments_booked
     OR p_proposals_sent > p_appointments_held
     OR p_closed_won + p_closed_lost > p_proposals_sent THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'revenue_head_structured_report_invalid';
  END IF;
  v_evidence_digest := public.revenue_head_evidence_digest(p_evidence);
  v_evidence_count := jsonb_array_length(p_evidence->'sources');
  SELECT count(DISTINCT source.value->>'source_type')
    INTO v_evidence_source_type_count
    FROM jsonb_array_elements(p_evidence->'sources') source(value);
  SELECT report.* INTO v_existing
    FROM public.revenue_head_reports report
   WHERE report.tenant_id = p_tenant_id
     AND report.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.request_fingerprint IS DISTINCT FROM p_request_fingerprint
       OR v_existing.id IS DISTINCT FROM p_report_id
       OR v_existing.charter_id IS DISTINCT FROM p_charter_id
       OR v_existing.period_start IS DISTINCT FROM p_period_start
       OR v_existing.period_end IS DISTINCT FROM p_period_end
       OR v_existing.source_system IS DISTINCT FROM p_source_system
       OR v_existing.source_report_id IS DISTINCT FROM p_source_report_id
       OR v_existing.leads_created IS DISTINCT FROM p_leads_created
       OR v_existing.qualified_leads IS DISTINCT FROM p_qualified_leads
       OR v_existing.appointments_booked IS DISTINCT FROM p_appointments_booked
       OR v_existing.appointments_held IS DISTINCT FROM p_appointments_held
       OR v_existing.proposals_sent IS DISTINCT FROM p_proposals_sent
       OR v_existing.closed_won IS DISTINCT FROM p_closed_won
       OR v_existing.closed_lost IS DISTINCT FROM p_closed_lost
       OR v_existing.open_pipeline_minor IS DISTINCT FROM p_open_pipeline_minor
       OR v_existing.booked_revenue_minor IS DISTINCT FROM p_booked_revenue_minor
       OR v_existing.currency IS DISTINCT FROM p_currency
       OR v_existing.average_sales_cycle_days IS DISTINCT FROM
          p_average_sales_cycle_days
       OR v_existing.evidence IS DISTINCT FROM p_evidence
       OR v_existing.evidence_digest IS DISTINCT FROM v_evidence_digest THEN
      RAISE EXCEPTION USING ERRCODE = '23505',
        MESSAGE = 'revenue_head_report_idempotency_conflict';
    END IF;
    RETURN jsonb_build_object('outcome', 'replay', 'report', to_jsonb(v_existing));
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.revenue_head_reports report
     WHERE report.id = p_report_id
        OR (
          report.source_system = p_source_system
          AND report.source_report_id = p_source_report_id
        )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23505',
      MESSAGE = 'revenue_head_report_identity_conflict';
  END IF;

  v_qualification := CASE WHEN p_leads_created > 0
    THEN floor(p_qualified_leads::numeric * 10000 / p_leads_created)::integer END;
  v_appointment := CASE WHEN p_qualified_leads > 0
    THEN floor(p_appointments_booked::numeric * 10000 / p_qualified_leads)::integer END;
  v_held := CASE WHEN p_appointments_booked > 0
    THEN floor(p_appointments_held::numeric * 10000 / p_appointments_booked)::integer END;
  v_proposal := CASE WHEN p_appointments_held > 0
    THEN floor(p_proposals_sent::numeric * 10000 / p_appointments_held)::integer END;
  v_win := CASE WHEN p_closed_won + p_closed_lost > 0
    THEN floor(p_closed_won::numeric * 10000 / (p_closed_won + p_closed_lost))::integer END;
  v_business := CASE
    WHEN v_evidence_count >= 2
      AND v_evidence_source_type_count >= 2
      AND p_closed_won + p_closed_lost > 0
      THEN 'observed'
    ELSE 'unverified'
  END;
  v_health := CASE
    WHEN v_evidence_count < 2 OR v_evidence_source_type_count < 2
      OR v_qualification IS NULL OR v_appointment IS NULL
      OR v_held IS NULL OR v_proposal IS NULL OR v_win IS NULL
      THEN 'unverified'
    WHEN v_qualification * 2 < v_charter.qualification_rate_target_bps
      OR v_appointment * 2 < v_charter.appointment_rate_target_bps
      OR v_held * 2 < v_charter.held_rate_target_bps
      OR v_proposal * 2 < v_charter.proposal_rate_target_bps
      OR v_win * 2 < v_charter.win_rate_target_bps
      OR p_average_sales_cycle_days >
         v_charter.max_sales_cycle_days * 1.5
      THEN 'critical'
    WHEN v_qualification < v_charter.qualification_rate_target_bps
      OR v_appointment < v_charter.appointment_rate_target_bps
      OR v_held < v_charter.held_rate_target_bps
      OR v_proposal < v_charter.proposal_rate_target_bps
      OR v_win < v_charter.win_rate_target_bps
      OR p_average_sales_cycle_days > v_charter.max_sales_cycle_days
      THEN 'at_risk'
    ELSE 'healthy'
  END;

  INSERT INTO public.revenue_head_reports (
    id, tenant_id, charter_id, period_start, period_end, source_system,
    source_report_id, leads_created, qualified_leads, appointments_booked,
    appointments_held, proposals_sent, closed_won, closed_lost,
    open_pipeline_minor, booked_revenue_minor, currency,
    average_sales_cycle_days, qualification_rate_bps, appointment_rate_bps,
    held_rate_bps, proposal_rate_bps, win_rate_bps, funnel_health,
    business_effect_state, evidence, evidence_count, evidence_digest,
    idempotency_key, request_fingerprint
  ) VALUES (
    p_report_id, p_tenant_id, p_charter_id, p_period_start, p_period_end,
    p_source_system, p_source_report_id, p_leads_created, p_qualified_leads,
    p_appointments_booked, p_appointments_held, p_proposals_sent,
    p_closed_won, p_closed_lost, p_open_pipeline_minor,
    p_booked_revenue_minor, p_currency, p_average_sales_cycle_days,
    v_qualification, v_appointment, v_held, v_proposal, v_win, v_health,
    v_business, p_evidence, v_evidence_count, v_evidence_digest,
    p_idempotency_key, p_request_fingerprint
  ) RETURNING * INTO v_report;
  RETURN jsonb_build_object('outcome', 'accepted', 'report', to_jsonb(v_report));
END;
$$;

CREATE OR REPLACE FUNCTION public.revenue_head_work_command_rpc(
  p_tenant_id uuid,
  p_item_id uuid,
  p_report_id uuid,
  p_command text,
  p_expected_revision bigint,
  p_actor_type text,
  p_actor_id text,
  p_authority_tier text,
  p_evidence jsonb,
  p_idempotency_key text,
  p_request_fingerprint text,
  p_feature_gate_enabled boolean DEFAULT false,
  p_item_kind text DEFAULT NULL,
  p_action_scope text DEFAULT NULL,
  p_title text DEFAULT NULL,
  p_assignee_type text DEFAULT NULL,
  p_assignee_id text DEFAULT NULL,
  p_due_at timestamptz DEFAULT NULL,
  p_escalation_code text DEFAULT NULL,
  p_completion_evidence_digest text DEFAULT NULL,
  p_decision text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_control public.revenue_head_controls%ROWTYPE;
  v_item public.revenue_head_items%ROWTYPE;
  v_existing public.revenue_head_events%ROWTYPE;
  v_event public.revenue_head_events%ROWTYPE;
  v_evidence_digest text;
  v_semantic_fingerprint text;
  v_previous_status text;
  v_resulting_status text;
  v_event_type text;
  v_actor_uuid uuid;
  v_assignee_uuid uuid;
BEGIN
  v_control := public.revenue_head_assert_control(
    p_tenant_id, p_feature_gate_enabled
  );
  IF p_command NOT IN (
    'create', 'accept', 'start', 'escalate', 'complete', 'record_decision'
  ) OR p_expected_revision < 0 THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'revenue_head_command_invalid';
  END IF;
  IF (p_command <> 'escalate' AND p_escalation_code IS NOT NULL)
     OR (
       p_command NOT IN ('complete', 'record_decision')
       AND p_completion_evidence_digest IS NOT NULL
     )
     OR (p_command <> 'record_decision' AND p_decision IS NOT NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'revenue_head_command_fields_forbidden';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.revenue_head_reports report
     WHERE report.id = p_report_id AND report.tenant_id = p_tenant_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'revenue_head_report_not_accepted_for_tenant';
  END IF;
  IF p_actor_type = 'agent' THEN
    IF p_authority_tier <> 'department_head'
       OR p_actor_id IS DISTINCT FROM v_control.registered_agent_id THEN
      RAISE EXCEPTION USING ERRCODE = '42501',
        MESSAGE = 'revenue_head_agent_identity_invalid';
    END IF;
  ELSIF p_actor_type = 'human' THEN
    BEGIN
      v_actor_uuid := p_actor_id::uuid;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION USING ERRCODE = '42501',
        MESSAGE = 'revenue_head_owner_identity_invalid';
    END;
    IF p_authority_tier <> 'owner'
       OR NOT EXISTS (
         SELECT 1 FROM public.tenant_users tenant_user
          WHERE tenant_user.tenant_id = p_tenant_id
            AND tenant_user.user_id = v_actor_uuid
            AND tenant_user.role IN (
              'owner', 'platform_owner', 'founder', 'admin',
              'client_owner', 'tenant_owner'
            )
       ) THEN
      RAISE EXCEPTION USING ERRCODE = '42501',
        MESSAGE = 'revenue_head_owner_identity_invalid';
    END IF;
  ELSIF p_actor_type = 'system' THEN
    IF p_actor_id IS NOT NULL OR p_authority_tier <> 'system' THEN
      RAISE EXCEPTION USING ERRCODE = '42501',
        MESSAGE = 'revenue_head_system_identity_invalid';
    END IF;
  ELSE
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'revenue_head_actor_invalid';
  END IF;
  v_evidence_digest := public.revenue_head_evidence_digest(p_evidence);
  v_semantic_fingerprint := encode(digest(convert_to(
    jsonb_build_object(
      'tenant_id', p_tenant_id, 'item_id', p_item_id,
      'report_id', p_report_id, 'command', p_command,
      'expected_revision', p_expected_revision, 'actor_type', p_actor_type,
      'actor_id', p_actor_id, 'authority_tier', p_authority_tier,
      'evidence_digest', v_evidence_digest, 'item_kind', p_item_kind,
      'action_scope', p_action_scope, 'title', p_title,
      'assignee_type', p_assignee_type, 'assignee_id', p_assignee_id,
      'due_at', p_due_at, 'escalation_code', p_escalation_code,
      'completion_evidence_digest', p_completion_evidence_digest,
      'decision', p_decision
    )::text, 'UTF8'), 'sha256'), 'hex');
  SELECT event.* INTO v_existing
    FROM public.revenue_head_events event
   WHERE event.tenant_id = p_tenant_id
     AND event.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.request_fingerprint IS DISTINCT FROM p_request_fingerprint
       OR v_existing.semantic_fingerprint IS DISTINCT FROM v_semantic_fingerprint THEN
      RAISE EXCEPTION USING ERRCODE = '23505',
        MESSAGE = 'revenue_head_work_idempotency_conflict';
    END IF;
    RETURN jsonb_build_object(
      'outcome', 'replay',
      'item', (
        SELECT to_jsonb(item) FROM public.revenue_head_items item
         WHERE item.id = p_item_id AND item.tenant_id = p_tenant_id
      ),
      'event', to_jsonb(v_existing)
    );
  END IF;
  IF p_command = 'create' THEN
    IF p_expected_revision <> 0
       OR p_item_kind NOT IN ('goal', 'work', 'decision', 'exception')
       OR p_action_scope NOT IN (
         'analyze_funnel', 'track_goal', 'recommend_action',
         'request_owner_decision', 'raise_exception', 'verify_evidence'
       )
       OR char_length(btrim(COALESCE(p_title, ''))) NOT BETWEEN 3 AND 240
       OR p_assignee_type NOT IN ('agent', 'human')
       OR char_length(btrim(COALESCE(p_assignee_id, ''))) NOT BETWEEN 2 AND 160
       OR p_due_at IS NULL OR p_due_at < now()
       OR (p_item_kind = 'goal' AND p_action_scope <> 'track_goal')
       OR (
         p_item_kind = 'decision'
         AND p_action_scope <> 'request_owner_decision'
       )
       OR (
         p_item_kind = 'exception'
         AND p_action_scope <> 'raise_exception'
       )
       OR (
         p_item_kind = 'work'
         AND p_action_scope NOT IN (
           'analyze_funnel', 'recommend_action', 'verify_evidence'
         )
       ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'revenue_head_supervised_scope_invalid';
    END IF;
    IF p_assignee_type = 'agent' THEN
      IF p_assignee_id IS DISTINCT FROM v_control.registered_agent_id THEN
        RAISE EXCEPTION USING ERRCODE = '42501',
          MESSAGE = 'revenue_head_assignee_identity_invalid';
      END IF;
    ELSE
      BEGIN
        v_assignee_uuid := p_assignee_id::uuid;
      EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION USING ERRCODE = '42501',
          MESSAGE = 'revenue_head_assignee_identity_invalid';
      END;
      IF NOT EXISTS (
        SELECT 1 FROM public.tenant_users tenant_user
         WHERE tenant_user.tenant_id = p_tenant_id
           AND tenant_user.user_id = v_assignee_uuid
      ) THEN
        RAISE EXCEPTION USING ERRCODE = '42501',
          MESSAGE = 'revenue_head_assignee_identity_invalid';
      END IF;
    END IF;
    IF p_item_kind = 'decision' AND p_assignee_type <> 'human' THEN
      RAISE EXCEPTION USING ERRCODE = '42501',
        MESSAGE = 'revenue_head_decision_requires_human_owner';
    END IF;
    IF p_item_kind = 'decision' AND NOT EXISTS (
      SELECT 1 FROM public.tenant_users tenant_user
       WHERE tenant_user.tenant_id = p_tenant_id
         AND tenant_user.user_id = v_assignee_uuid
         AND tenant_user.role IN (
           'owner', 'platform_owner', 'founder', 'admin',
           'client_owner', 'tenant_owner'
         )
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '42501',
        MESSAGE = 'revenue_head_decision_requires_human_owner';
    END IF;
    INSERT INTO public.revenue_head_items (
      id, tenant_id, report_id, item_kind, action_scope, title,
      assignee_type, assignee_id, due_at, decision_state
    ) VALUES (
      p_item_id, p_tenant_id, p_report_id, p_item_kind, p_action_scope,
      p_title, p_assignee_type, p_assignee_id, p_due_at,
      CASE WHEN p_item_kind = 'decision' THEN 'pending' ELSE 'not_applicable' END
    ) RETURNING * INTO v_item;
    v_previous_status := NULL;
    v_resulting_status := 'assigned';
    v_event_type := 'assigned';
  ELSE
    IF p_item_kind IS NOT NULL OR p_action_scope IS NOT NULL OR p_title IS NOT NULL
       OR p_assignee_type IS NOT NULL OR p_assignee_id IS NOT NULL
       OR p_due_at IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'revenue_head_create_fields_forbidden';
    END IF;
    SELECT item.* INTO STRICT v_item
      FROM public.revenue_head_items item
     WHERE item.id = p_item_id
       AND item.tenant_id = p_tenant_id
       AND item.report_id = p_report_id
     FOR UPDATE;
    IF v_item.revision IS DISTINCT FROM p_expected_revision THEN
      RAISE EXCEPTION USING ERRCODE = '40001',
        MESSAGE = 'revenue_head_item_revision_conflict';
    END IF;
    v_previous_status := v_item.status;
    IF p_command = 'accept' THEN
      IF v_item.status <> 'assigned'
         OR p_actor_type IS DISTINCT FROM v_item.assignee_type
         OR p_actor_id IS DISTINCT FROM v_item.assignee_id THEN
        RAISE EXCEPTION USING ERRCODE = '42501',
          MESSAGE = 'revenue_head_acceptance_contract_invalid';
      END IF;
      UPDATE public.revenue_head_items SET
        status = 'accepted', accepted_at = now(),
        revision = revision + 1, updated_at = now()
      WHERE id = p_item_id AND tenant_id = p_tenant_id
      RETURNING * INTO v_item;
      v_resulting_status := 'accepted';
      v_event_type := 'accepted';
    ELSIF p_command = 'start' THEN
      IF v_item.status <> 'accepted'
         OR p_actor_type IS DISTINCT FROM v_item.assignee_type
         OR p_actor_id IS DISTINCT FROM v_item.assignee_id THEN
        RAISE EXCEPTION USING ERRCODE = '42501',
          MESSAGE = 'revenue_head_start_contract_invalid';
      END IF;
      UPDATE public.revenue_head_items SET
        status = 'in_progress', started_at = now(),
        revision = revision + 1, updated_at = now()
      WHERE id = p_item_id AND tenant_id = p_tenant_id
      RETURNING * INTO v_item;
      v_resulting_status := 'in_progress';
      v_event_type := 'started';
    ELSIF p_command = 'escalate' THEN
      IF v_item.status NOT IN ('assigned', 'accepted', 'in_progress')
         OR p_escalation_code !~ '^[a-z][a-z0-9_]{1,63}$'
         OR (now() < v_item.due_at AND p_authority_tier <> 'owner') THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
          MESSAGE = 'revenue_head_escalation_contract_invalid';
      END IF;
      UPDATE public.revenue_head_items SET
        status = 'escalated', escalated_at = now(),
        escalation_code = p_escalation_code,
        revision = revision + 1, updated_at = now()
      WHERE id = p_item_id AND tenant_id = p_tenant_id
      RETURNING * INTO v_item;
      v_resulting_status := 'escalated';
      v_event_type := 'escalated';
    ELSIF p_command = 'complete' THEN
      IF v_item.status NOT IN ('accepted', 'in_progress', 'escalated')
         OR v_item.item_kind = 'decision'
         OR p_completion_evidence_digest !~ '^[a-f0-9]{64}$'
         OR (
           p_authority_tier <> 'owner'
           AND (
             p_actor_type IS DISTINCT FROM v_item.assignee_type
             OR p_actor_id IS DISTINCT FROM v_item.assignee_id
           )
         ) THEN
        RAISE EXCEPTION USING ERRCODE = '42501',
          MESSAGE = 'revenue_head_completion_contract_invalid';
      END IF;
      UPDATE public.revenue_head_items SET
        status = 'completed', completed_at = now(),
        completion_evidence_digest = p_completion_evidence_digest,
        revision = revision + 1, updated_at = now()
      WHERE id = p_item_id AND tenant_id = p_tenant_id
      RETURNING * INTO v_item;
      v_resulting_status := 'completed';
      v_event_type := 'completed';
    ELSE
      IF p_command <> 'record_decision'
         OR v_item.item_kind <> 'decision'
         OR v_item.decision_state <> 'pending'
         OR v_item.status NOT IN ('accepted', 'in_progress', 'escalated')
         OR p_actor_type <> 'human' OR p_authority_tier <> 'owner'
         OR p_decision NOT IN ('approved', 'rejected')
         OR p_completion_evidence_digest !~ '^[a-f0-9]{64}$' THEN
        RAISE EXCEPTION USING ERRCODE = '42501',
          MESSAGE = 'revenue_head_owner_decision_contract_invalid';
      END IF;
      UPDATE public.revenue_head_items SET
        status = 'completed', completed_at = now(),
        completion_evidence_digest = p_completion_evidence_digest,
        decision_state = p_decision,
        revision = revision + 1, updated_at = now()
      WHERE id = p_item_id AND tenant_id = p_tenant_id
      RETURNING * INTO v_item;
      v_resulting_status := 'completed';
      v_event_type := 'decision_recorded';
    END IF;
  END IF;
  INSERT INTO public.revenue_head_events (
    tenant_id, item_id, report_id, event_type, previous_status,
    resulting_status, expected_revision, resulting_revision,
    actor_type, actor_id, authority_tier, evidence, evidence_digest,
    idempotency_key, request_fingerprint, semantic_fingerprint
  ) VALUES (
    p_tenant_id, p_item_id, p_report_id, v_event_type, v_previous_status,
    v_resulting_status, p_expected_revision, v_item.revision,
    p_actor_type, p_actor_id, p_authority_tier, p_evidence, v_evidence_digest,
    p_idempotency_key, p_request_fingerprint, v_semantic_fingerprint
  ) RETURNING * INTO v_event;
  RETURN jsonb_build_object(
    'outcome', 'applied', 'item', to_jsonb(v_item), 'event', to_jsonb(v_event)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.revenue_head_kill_switch_rpc(
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
  v_control public.revenue_head_controls%ROWTYPE;
BEGIN
  v_claims := NULLIF(current_setting('request.jwt.claims', true), '');
  v_calling_role := COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    CASE WHEN v_claims IS NOT NULL THEN v_claims::jsonb ->> 'role' END,
    session_user::text
  );
  IF v_calling_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'revenue_head_kill_switch_requires_service_role';
  END IF;
  IF p_tenant_id IS NULL
     OR btrim(COALESCE(p_reason, '')) !~ '^[a-z][a-z0-9_:-]{2,79}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'revenue_head_kill_switch_reason_invalid';
  END IF;
  UPDATE public.revenue_head_controls SET
    enabled = false,
    execution_mode = 'disabled',
    kill_switch_engaged = true,
    activation_evidence = activation_evidence || jsonb_build_object(
      'kill_switch_reason_digest',
      encode(digest(btrim(p_reason), 'sha256'), 'hex'),
      'kill_switch_engaged_at', now()
    )
  WHERE tenant_id = p_tenant_id
  RETURNING * INTO v_control;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002',
      MESSAGE = 'revenue_head_control_not_found';
  END IF;
  RETURN jsonb_build_object(
    'outcome', 'kill_switch_engaged',
    'tenant_id', v_control.tenant_id,
    'revision', v_control.revision
  );
END;
$$;

REVOKE ALL ON FUNCTION public.revenue_head_evidence_digest(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.revenue_head_assert_control(uuid, boolean)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.revenue_head_charter_register_rpc(
  uuid, integer, text, integer, integer, integer, integer, integer, integer,
  uuid, jsonb, text, text, boolean
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.revenue_head_report_accept_rpc(
  uuid, uuid, uuid, date, date, text, text, integer, integer, integer,
  integer, integer, integer, integer, bigint, bigint, text, numeric, jsonb,
  text, text, boolean
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.revenue_head_work_command_rpc(
  uuid, uuid, uuid, text, bigint, text, text, text, jsonb, text, text,
  boolean, text, text, text, text, text, timestamptz, text, text, text
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.revenue_head_kill_switch_rpc(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.revenue_head_charter_register_rpc(
  uuid, integer, text, integer, integer, integer, integer, integer, integer,
  uuid, jsonb, text, text, boolean
) TO service_role;
GRANT EXECUTE ON FUNCTION public.revenue_head_report_accept_rpc(
  uuid, uuid, uuid, date, date, text, text, integer, integer, integer,
  integer, integer, integer, integer, bigint, bigint, text, numeric, jsonb,
  text, text, boolean
) TO service_role;
GRANT EXECUTE ON FUNCTION public.revenue_head_work_command_rpc(
  uuid, uuid, uuid, text, bigint, text, text, text, jsonb, text, text,
  boolean, text, text, text, text, text, timestamptz, text, text, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.revenue_head_kill_switch_rpc(uuid, text)
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.revenue_head_immutable_row()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.revenue_head_item_identity_guard()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.revenue_head_control_guard()
  FROM PUBLIC, anon, authenticated, service_role;
