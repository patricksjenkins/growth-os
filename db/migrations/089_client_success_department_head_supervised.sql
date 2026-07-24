-- ============================================================================
-- Migration 089: Supervised Client Success & Support Department Head
-- Date: 2026-07-24
--
-- Additive, default-off, evidence-only control plane. This migration never
-- sends a customer communication, calls a provider, changes customer state,
-- issues credits/refunds, or obtains production write authority. A completed
-- work item or intervention is not an observed client outcome.
--
-- ROLLBACK:
--   db/rollbacks/089_client_success_department_head_supervised_rollback.sql
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.client_success_head_controls (
  tenant_id                       uuid PRIMARY KEY
                                  REFERENCES public.tenants(id) ON DELETE CASCADE,
  enabled                         boolean NOT NULL DEFAULT false,
  execution_mode                  text NOT NULL DEFAULT 'disabled'
                                  CHECK (execution_mode IN (
                                    'disabled', 'supervised_read_only'
                                  )),
  kill_switch_engaged             boolean NOT NULL DEFAULT true,
  registered_agent_id             text CHECK (
                                    registered_agent_id IS NULL OR
                                    char_length(btrim(registered_agent_id))
                                      BETWEEN 2 AND 160
                                  ),
  registered_support_adapter_id   text CHECK (
                                    registered_support_adapter_id IS NULL OR
                                    char_length(btrim(registered_support_adapter_id))
                                      BETWEEN 2 AND 160
                                  ),
  production_write_authority      boolean NOT NULL DEFAULT false
                                  CHECK (production_write_authority = false),
  customer_communications_enabled boolean NOT NULL DEFAULT false
                                  CHECK (customer_communications_enabled = false),
  provider_dispatch_enabled       boolean NOT NULL DEFAULT false
                                  CHECK (provider_dispatch_enabled = false),
  financial_authority_enabled     boolean NOT NULL DEFAULT false
                                  CHECK (financial_authority_enabled = false),
  refund_credit_authority_enabled boolean NOT NULL DEFAULT false
                                  CHECK (refund_credit_authority_enabled = false),
  revision                        bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  activated_by                    uuid,
  activation_evidence             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.client_success_head_charters (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                       uuid NOT NULL
                                  REFERENCES public.tenants(id) ON DELETE RESTRICT,
  version                         integer NOT NULL CHECK (version > 0),
  mission                         text NOT NULL CHECK (
                                    char_length(btrim(mission)) BETWEEN 40 AND 1000
                                  ),
  max_first_response_minutes      integer NOT NULL CHECK (
                                    max_first_response_minutes BETWEEN 1 AND 100000
                                  ),
  max_resolution_minutes          integer NOT NULL CHECK (
                                    max_resolution_minutes BETWEEN 1 AND 10000000
                                  ),
  max_sla_breach_rate_bps         integer NOT NULL CHECK (
                                    max_sla_breach_rate_bps BETWEEN 0 AND 10000
                                  ),
  min_csat_bps                    integer NOT NULL CHECK (
                                    min_csat_bps BETWEEN 1 AND 10000
                                  ),
  max_open_critical_tickets       integer NOT NULL CHECK (
                                    max_open_critical_tickets BETWEEN 0 AND 1000000
                                  ),
  evidence                        jsonb NOT NULL,
  evidence_digest                 text NOT NULL CHECK (
                                    evidence_digest ~ '^[a-f0-9]{64}$'
                                  ),
  actor_id                        uuid NOT NULL,
  idempotency_key                 text NOT NULL CHECK (
                                    char_length(idempotency_key) BETWEEN 8 AND 200
                                  ),
  request_fingerprint             text NOT NULL CHECK (
                                    request_fingerprint ~ '^[a-f0-9]{64}$'
                                  ),
  created_at                      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, version),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS public.client_success_support_snapshots (
  id                              uuid PRIMARY KEY,
  tenant_id                       uuid NOT NULL
                                  REFERENCES public.tenants(id) ON DELETE RESTRICT,
  customer_id                     uuid NOT NULL
                                  REFERENCES public.customers(id) ON DELETE RESTRICT,
  schema_version                  integer NOT NULL DEFAULT 1
                                  CHECK (schema_version = 1),
  source_system                   text NOT NULL DEFAULT 'support_ledger'
                                  CHECK (source_system = 'support_ledger'),
  source_snapshot_id              text NOT NULL CHECK (
                                    char_length(source_snapshot_id) BETWEEN 2 AND 240
                                    AND source_snapshot_id ~
                                      '^[A-Za-z0-9][A-Za-z0-9._:/-]{1,239}$'
                                  ),
  evidence_digest                 text NOT NULL CHECK (
                                    evidence_digest ~ '^[a-f0-9]{64}$'
                                  ),
  observed_at                     timestamptz NOT NULL,
  verification_state              text NOT NULL CHECK (
                                    verification_state IN ('verified', 'unverified')
                                  ),
  opened_tickets                  integer NOT NULL CHECK (opened_tickets >= 0),
  resolved_tickets                integer NOT NULL CHECK (resolved_tickets >= 0),
  sla_breached_tickets            integer NOT NULL CHECK (
                                    sla_breached_tickets >= 0
                                  ),
  open_critical_tickets           integer NOT NULL CHECK (
                                    open_critical_tickets >= 0
                                  ),
  first_response_minutes          numeric(12,3) NOT NULL CHECK (
                                    first_response_minutes BETWEEN 0 AND 100000
                                  ),
  resolution_minutes              numeric(12,3) NOT NULL CHECK (
                                    resolution_minutes BETWEEN 0 AND 10000000
                                  ),
  csat_bps                        integer NOT NULL CHECK (
                                    csat_bps BETWEEN 0 AND 10000
                                  ),
  recorded_by_adapter_id          text NOT NULL CHECK (
                                    char_length(btrim(recorded_by_adapter_id))
                                      BETWEEN 2 AND 160
                                  ),
  idempotency_key                 text NOT NULL CHECK (
                                    char_length(idempotency_key) BETWEEN 8 AND 200
                                  ),
  request_fingerprint             text NOT NULL CHECK (
                                    request_fingerprint ~ '^[a-f0-9]{64}$'
                                  ),
  created_at                      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (id, tenant_id, customer_id),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (source_system, source_snapshot_id),
  CHECK (resolved_tickets <= opened_tickets),
  CHECK (sla_breached_tickets <= opened_tickets),
  CHECK (observed_at <= created_at + interval '5 minutes')
);

CREATE TABLE IF NOT EXISTS public.client_success_head_reports (
  id                              uuid PRIMARY KEY,
  tenant_id                       uuid NOT NULL
                                  REFERENCES public.tenants(id) ON DELETE RESTRICT,
  charter_id                      uuid NOT NULL,
  customer_id                     uuid NOT NULL,
  health_snapshot_id              uuid NOT NULL,
  intervention_id                 uuid,
  schema_version                  integer NOT NULL DEFAULT 1
                                  CHECK (schema_version = 1),
  report_type                     text NOT NULL DEFAULT 'client_outcome_v1'
                                  CHECK (report_type = 'client_outcome_v1'),
  period_start                    date NOT NULL,
  period_end                      date NOT NULL,
  support_snapshot_id             uuid NOT NULL,
  support_source_system           text NOT NULL DEFAULT 'support_ledger'
                                  CHECK (support_source_system = 'support_ledger'),
  support_source_id               text NOT NULL CHECK (
                                    char_length(support_source_id) BETWEEN 2 AND 240
                                    AND support_source_id ~
                                      '^[A-Za-z0-9][A-Za-z0-9._:/-]{1,239}$'
                                  ),
  support_evidence_digest         text NOT NULL CHECK (
                                    support_evidence_digest ~ '^[a-f0-9]{64}$'
                                  ),
  support_observed_at             timestamptz NOT NULL,
  opened_tickets                  integer NOT NULL CHECK (opened_tickets >= 0),
  resolved_tickets                integer NOT NULL CHECK (resolved_tickets >= 0),
  sla_breached_tickets            integer NOT NULL CHECK (
                                    sla_breached_tickets >= 0
                                  ),
  open_critical_tickets           integer NOT NULL CHECK (
                                    open_critical_tickets >= 0
                                  ),
  first_response_minutes          numeric(12,3) NOT NULL CHECK (
                                    first_response_minutes BETWEEN 0 AND 100000
                                  ),
  resolution_minutes              numeric(12,3) NOT NULL CHECK (
                                    resolution_minutes BETWEEN 0 AND 10000000
                                  ),
  csat_bps                        integer NOT NULL CHECK (
                                    csat_bps BETWEEN 0 AND 10000
                                  ),
  sla_breach_rate_bps             integer CHECK (
                                    sla_breach_rate_bps BETWEEN 0 AND 10000
                                  ),
  service_health                  text NOT NULL CHECK (
                                    service_health IN (
                                      'healthy', 'at_risk', 'critical', 'unverified'
                                    )
                                  ),
  client_outcome_state            text NOT NULL CHECK (
                                    client_outcome_state IN (
                                      'improved', 'unchanged', 'worsened',
                                      'observed_stable', 'unproven'
                                    )
                                  ),
  outcome_healthy                 boolean GENERATED ALWAYS AS (
                                    service_health = 'healthy'
                                    AND client_outcome_state IN (
                                      'improved', 'observed_stable'
                                    )
                                  ) STORED,
  evidence                        jsonb NOT NULL,
  evidence_count                  integer NOT NULL CHECK (evidence_count > 0),
  evidence_digest                 text NOT NULL CHECK (
                                    evidence_digest ~ '^[a-f0-9]{64}$'
                                  ),
  accepted_by_head_id             text NOT NULL CHECK (
                                    char_length(btrim(accepted_by_head_id))
                                      BETWEEN 2 AND 160
                                  ),
  accepted_authority_tier         text NOT NULL DEFAULT 'department_head'
                                  CHECK (
                                    accepted_authority_tier = 'department_head'
                                  ),
  accepted_at                     timestamptz NOT NULL DEFAULT now(),
  idempotency_key                 text NOT NULL CHECK (
                                    char_length(idempotency_key) BETWEEN 8 AND 200
                                  ),
  request_fingerprint             text NOT NULL CHECK (
                                    request_fingerprint ~ '^[a-f0-9]{64}$'
                                  ),
  created_at                      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (support_source_system, support_source_id),
  FOREIGN KEY (charter_id, tenant_id)
    REFERENCES public.client_success_head_charters(id, tenant_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (health_snapshot_id, tenant_id, customer_id)
    REFERENCES public.client_health_signal_snapshots(id, tenant_id, customer_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (intervention_id, tenant_id, customer_id)
    REFERENCES public.client_health_interventions(id, tenant_id, customer_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (support_snapshot_id, tenant_id, customer_id)
    REFERENCES public.client_success_support_snapshots(id, tenant_id, customer_id)
    ON DELETE RESTRICT,
  CHECK (period_end >= period_start),
  CHECK (resolved_tickets <= opened_tickets),
  CHECK (sla_breached_tickets <= opened_tickets),
  CHECK (
    (opened_tickets = 0 AND sla_breach_rate_bps IS NULL)
    OR (opened_tickets > 0 AND sla_breach_rate_bps IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS public.client_success_head_items (
  id                              uuid PRIMARY KEY,
  tenant_id                       uuid NOT NULL
                                  REFERENCES public.tenants(id) ON DELETE RESTRICT,
  report_id                       uuid NOT NULL,
  item_kind                       text NOT NULL CHECK (
                                    item_kind IN ('goal', 'work', 'decision', 'exception')
                                  ),
  action_scope                    text NOT NULL CHECK (
                                    action_scope IN (
                                      'analyze_client_health', 'track_client_goal',
                                      'recommend_intervention',
                                      'request_owner_decision',
                                      'raise_client_exception',
                                      'verify_support_evidence'
                                    )
                                  ),
  title                           text NOT NULL CHECK (
                                    char_length(btrim(title)) BETWEEN 3 AND 240
                                  ),
  status                          text NOT NULL DEFAULT 'assigned' CHECK (
                                    status IN (
                                      'assigned', 'accepted', 'in_progress',
                                      'escalated', 'completed'
                                    )
                                  ),
  revision                        bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  assignee_type                   text NOT NULL CHECK (
                                    assignee_type IN ('agent', 'human')
                                  ),
  assignee_id                     text NOT NULL CHECK (
                                    char_length(btrim(assignee_id)) BETWEEN 2 AND 160
                                  ),
  assigned_at                     timestamptz NOT NULL DEFAULT now(),
  accepted_at                     timestamptz,
  started_at                      timestamptz,
  due_at                          timestamptz NOT NULL,
  escalated_at                    timestamptz,
  escalation_code                text CHECK (
                                    escalation_code IS NULL OR
                                    escalation_code ~ '^[a-z][a-z0-9_]{1,63}$'
                                  ),
  completed_at                    timestamptz,
  completion_evidence_digest      text CHECK (
                                    completion_evidence_digest IS NULL OR
                                    completion_evidence_digest ~ '^[a-f0-9]{64}$'
                                  ),
  decision_state                  text NOT NULL DEFAULT 'not_applicable' CHECK (
                                    decision_state IN (
                                      'not_applicable', 'pending',
                                      'approved', 'rejected'
                                    )
                                  ),
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (report_id, tenant_id)
    REFERENCES public.client_success_head_reports(id, tenant_id) ON DELETE RESTRICT,
  CHECK (due_at >= assigned_at),
  CHECK (
    (item_kind = 'goal' AND action_scope = 'track_client_goal')
    OR (item_kind = 'decision' AND action_scope = 'request_owner_decision')
    OR (item_kind = 'exception' AND action_scope = 'raise_client_exception')
    OR (
      item_kind = 'work' AND action_scope IN (
        'analyze_client_health', 'recommend_intervention',
        'verify_support_evidence'
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
    (status = 'assigned' AND accepted_at IS NULL AND started_at IS NULL
      AND escalated_at IS NULL AND completed_at IS NULL)
    OR (status = 'accepted' AND accepted_at IS NOT NULL AND started_at IS NULL
      AND escalated_at IS NULL AND completed_at IS NULL)
    OR (status = 'in_progress' AND accepted_at IS NOT NULL
      AND started_at IS NOT NULL AND escalated_at IS NULL
      AND completed_at IS NULL)
    OR (status = 'escalated' AND escalated_at IS NOT NULL
      AND escalation_code IS NOT NULL AND completed_at IS NULL)
    OR (status = 'completed' AND completed_at IS NOT NULL
      AND completion_evidence_digest IS NOT NULL)
  ),
  CHECK (
    decision_state NOT IN ('approved', 'rejected') OR status = 'completed'
  )
);

CREATE TABLE IF NOT EXISTS public.client_success_head_events (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                       uuid NOT NULL,
  item_id                         uuid NOT NULL,
  report_id                       uuid NOT NULL,
  event_type                      text NOT NULL CHECK (
                                    event_type IN (
                                      'assigned', 'accepted', 'started',
                                      'escalated', 'completed', 'decision_recorded'
                                    )
                                  ),
  previous_status                 text,
  resulting_status                text NOT NULL,
  expected_revision               bigint NOT NULL CHECK (expected_revision >= 0),
  resulting_revision              bigint NOT NULL CHECK (resulting_revision > 0),
  actor_type                      text NOT NULL CHECK (
                                    actor_type IN ('agent', 'human', 'system')
                                  ),
  actor_id                        text,
  authority_tier                 text NOT NULL CHECK (
                                    authority_tier IN (
                                      'system', 'department_head', 'owner'
                                    )
                                  ),
  evidence                        jsonb NOT NULL,
  evidence_digest                 text NOT NULL CHECK (
                                    evidence_digest ~ '^[a-f0-9]{64}$'
                                  ),
  idempotency_key                 text NOT NULL CHECK (
                                    char_length(idempotency_key) BETWEEN 8 AND 200
                                  ),
  request_fingerprint             text NOT NULL CHECK (
                                    request_fingerprint ~ '^[a-f0-9]{64}$'
                                  ),
  semantic_fingerprint            text NOT NULL CHECK (
                                    semantic_fingerprint ~ '^[a-f0-9]{64}$'
                                  ),
  occurred_at                     timestamptz NOT NULL DEFAULT now(),
  created_at                      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (item_id, tenant_id)
    REFERENCES public.client_success_head_items(id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (report_id, tenant_id)
    REFERENCES public.client_success_head_reports(id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_client_success_head_reports_health
  ON public.client_success_head_reports
    (tenant_id, service_health, client_outcome_state, period_end DESC);
CREATE INDEX IF NOT EXISTS idx_client_success_head_reports_customer
  ON public.client_success_head_reports (tenant_id, customer_id, period_end DESC);
CREATE INDEX IF NOT EXISTS idx_client_success_head_items_sla
  ON public.client_success_head_items (tenant_id, status, due_at)
  WHERE status <> 'completed';
CREATE INDEX IF NOT EXISTS idx_client_success_head_events_history
  ON public.client_success_head_events (tenant_id, item_id, occurred_at, id);
CREATE INDEX IF NOT EXISTS idx_client_success_support_snapshots_customer
  ON public.client_success_support_snapshots
    (tenant_id, customer_id, observed_at DESC, id);

CREATE OR REPLACE FUNCTION public.client_success_support_snapshot_tenant_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.customers customer
     WHERE customer.id = NEW.customer_id
       AND customer.tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'client_success_support_snapshot_customer_tenant_mismatch';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_client_success_support_snapshot_tenant_guard
  ON public.client_success_support_snapshots;
CREATE TRIGGER trg_client_success_support_snapshot_tenant_guard
  BEFORE INSERT ON public.client_success_support_snapshots
  FOR EACH ROW
  EXECUTE FUNCTION public.client_success_support_snapshot_tenant_guard();

CREATE OR REPLACE FUNCTION public.client_success_head_immutable_row()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '55000',
    MESSAGE = 'client_success_head_evidence_is_immutable';
END;
$$;

DROP TRIGGER IF EXISTS trg_client_success_head_charters_immutable
  ON public.client_success_head_charters;
CREATE TRIGGER trg_client_success_head_charters_immutable
  BEFORE UPDATE OR DELETE ON public.client_success_head_charters
  FOR EACH ROW EXECUTE FUNCTION public.client_success_head_immutable_row();
DROP TRIGGER IF EXISTS trg_client_success_support_snapshots_immutable
  ON public.client_success_support_snapshots;
CREATE TRIGGER trg_client_success_support_snapshots_immutable
  BEFORE UPDATE OR DELETE ON public.client_success_support_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.client_success_head_immutable_row();
DROP TRIGGER IF EXISTS trg_client_success_head_reports_immutable
  ON public.client_success_head_reports;
CREATE TRIGGER trg_client_success_head_reports_immutable
  BEFORE UPDATE OR DELETE ON public.client_success_head_reports
  FOR EACH ROW EXECUTE FUNCTION public.client_success_head_immutable_row();
DROP TRIGGER IF EXISTS trg_client_success_head_events_immutable
  ON public.client_success_head_events;
CREATE TRIGGER trg_client_success_head_events_immutable
  BEFORE UPDATE OR DELETE ON public.client_success_head_events
  FOR EACH ROW EXECUTE FUNCTION public.client_success_head_immutable_row();

CREATE OR REPLACE FUNCTION public.client_success_head_item_identity_guard()
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
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'client_success_head_item_identity_is_immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_client_success_head_item_identity_guard
  ON public.client_success_head_items;
CREATE TRIGGER trg_client_success_head_item_identity_guard
  BEFORE UPDATE ON public.client_success_head_items
  FOR EACH ROW EXECUTE FUNCTION public.client_success_head_item_identity_guard();

CREATE OR REPLACE FUNCTION public.client_success_head_control_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.kill_switch_engaged = true
     AND NEW.kill_switch_engaged = false THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'client_success_head_kill_switch_is_one_way';
  END IF;
  IF NEW.production_write_authority IS DISTINCT FROM false
     OR NEW.customer_communications_enabled IS DISTINCT FROM false
     OR NEW.provider_dispatch_enabled IS DISTINCT FROM false
     OR NEW.financial_authority_enabled IS DISTINCT FROM false
     OR NEW.refund_credit_authority_enabled IS DISTINCT FROM false THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'client_success_head_production_authority_forbidden';
  END IF;
  IF NEW.enabled = true AND (
    NEW.execution_mode <> 'supervised_read_only'
    OR NEW.kill_switch_engaged IS DISTINCT FROM false
    OR char_length(btrim(COALESCE(NEW.registered_agent_id, '')))
       NOT BETWEEN 2 AND 160
    OR char_length(btrim(COALESCE(NEW.registered_support_adapter_id, '')))
       NOT BETWEEN 2 AND 160
    OR NEW.registered_support_adapter_id IS NOT DISTINCT FROM
       NEW.registered_agent_id
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
      MESSAGE = 'client_success_head_activation_invalid';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    NEW.revision := OLD.revision + 1;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_client_success_head_control_guard
  ON public.client_success_head_controls;
CREATE TRIGGER trg_client_success_head_control_guard
  BEFORE INSERT OR UPDATE ON public.client_success_head_controls
  FOR EACH ROW EXECUTE FUNCTION public.client_success_head_control_guard();

ALTER TABLE public.client_success_head_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_success_head_charters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_success_support_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_success_head_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_success_head_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_success_head_events ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'client_success_head_controls', 'client_success_head_charters',
    'client_success_support_snapshots',
    'client_success_head_reports', 'client_success_head_items',
    'client_success_head_events'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I',
      'tenant_iso_' || v_table, v_table);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (' ||
      'tenant_id = NULLIF(auth.jwt()->''app_metadata''->>''tenant_id'', '''')::uuid ' ||
      'AND auth.jwt()->''app_metadata''->>''role'' IN (' ||
      '''owner'', ''platform_owner'', ''founder'', ''admin'', ' ||
      '''client_owner'', ''tenant_owner'', ''client_success'', ' ||
      '''support'', ''manager''))',
      'tenant_iso_' || v_table, v_table
    );
  END LOOP;
END $$;

GRANT SELECT ON
  public.client_success_head_controls,
  public.client_success_head_charters,
  public.client_success_support_snapshots,
  public.client_success_head_reports,
  public.client_success_head_items,
  public.client_success_head_events
TO authenticated, service_role;
REVOKE INSERT, UPDATE, DELETE ON
  public.client_success_head_controls,
  public.client_success_head_charters,
  public.client_success_support_snapshots,
  public.client_success_head_reports,
  public.client_success_head_items,
  public.client_success_head_events
FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.client_success_head_evidence_digest(
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
     OR p_evidence - ARRAY['schema_version', 'sources'] <> '{}'::jsonb
     OR p_evidence::text ~* (
       '"(email|phone|recipient|message|body|reply|send|dispatch|provider|'
       'provider_payload|providerPayload|provider_token|providerToken|'
       'raw_ticket|rawTicket|ticket_body|ticketBody|customer_name|customerName|'
       'customer_email|customerEmail|customer_phone|customerPhone|'
       'charge|refund|credit|payment)"[[:space:]]*:'
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'client_success_head_evidence_contract_invalid';
  END IF;
  FOR v_source IN
    SELECT value FROM jsonb_array_elements(p_evidence->'sources')
  LOOP
    IF jsonb_typeof(v_source) <> 'object'
       OR v_source - ARRAY[
         'source_type', 'source_id', 'evidence_digest', 'observed_at'
       ] <> '{}'::jsonb
       OR v_source->>'source_type' !~ '^[a-z][a-z0-9_]{1,63}$'
       OR char_length(COALESCE(v_source->>'source_id', '')) NOT BETWEEN 2 AND 240
       OR COALESCE(v_source->>'source_id', '') !~
          '^[A-Za-z0-9][A-Za-z0-9._:/-]{1,239}$'
       OR COALESCE(v_source->>'source_id', '') LIKE '%@%'
       OR COALESCE(v_source->>'evidence_digest', '') !~ '^[a-f0-9]{64}$'
       OR NULLIF(v_source->>'observed_at', '') IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'client_success_head_evidence_source_invalid';
    END IF;
    BEGIN
      IF (v_source->>'observed_at')::timestamptz >
         now() + interval '5 minutes' THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
          MESSAGE = 'client_success_head_evidence_from_future';
      END IF;
    EXCEPTION WHEN invalid_datetime_format THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'client_success_head_evidence_time_invalid';
    END;
  END LOOP;
  IF (
    SELECT count(*) <> count(DISTINCT (
      source.value->>'source_type', source.value->>'source_id'
    ))
      FROM jsonb_array_elements(p_evidence->'sources') source(value)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'client_success_head_duplicate_evidence_source';
  END IF;
  RETURN encode(digest(convert_to(p_evidence::text, 'UTF8'), 'sha256'), 'hex');
END;
$$;

CREATE OR REPLACE FUNCTION public.client_success_head_assert_control(
  p_tenant_id uuid,
  p_feature_gate_enabled boolean
) RETURNS public.client_success_head_controls
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_claims text;
  v_calling_role text;
  v_control public.client_success_head_controls%ROWTYPE;
BEGIN
  v_claims := NULLIF(current_setting('request.jwt.claims', true), '');
  v_calling_role := COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    CASE WHEN v_claims IS NOT NULL THEN v_claims::jsonb ->> 'role' END,
    session_user::text
  );
  IF v_calling_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'client_success_head_requires_service_role';
  END IF;
  IF p_feature_gate_enabled IS DISTINCT FROM true THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'client_success_head_writes_disabled';
  END IF;
  SELECT control.* INTO STRICT v_control
    FROM public.client_success_head_controls control
   WHERE control.tenant_id = p_tenant_id
   FOR UPDATE;
  IF v_control.enabled IS DISTINCT FROM true
     OR v_control.execution_mode <> 'supervised_read_only'
     OR v_control.kill_switch_engaged IS DISTINCT FROM false
     OR v_control.production_write_authority IS DISTINCT FROM false
     OR v_control.customer_communications_enabled IS DISTINCT FROM false
     OR v_control.provider_dispatch_enabled IS DISTINCT FROM false
     OR v_control.financial_authority_enabled IS DISTINCT FROM false
     OR v_control.refund_credit_authority_enabled IS DISTINCT FROM false THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'client_success_head_control_not_active';
  END IF;
  IF char_length(btrim(COALESCE(v_control.registered_agent_id, '')))
       NOT BETWEEN 2 AND 160
     OR char_length(btrim(COALESCE(
       v_control.registered_support_adapter_id, ''
     ))) NOT BETWEEN 2 AND 160
     OR v_control.registered_support_adapter_id IS NOT DISTINCT FROM
        v_control.registered_agent_id THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'client_success_head_identity_separation_invalid';
  END IF;
  RETURN v_control;
END;
$$;

CREATE OR REPLACE FUNCTION public.client_success_support_snapshot_record_rpc(
  p_tenant_id uuid,
  p_snapshot_id uuid,
  p_customer_id uuid,
  p_source_snapshot_id text,
  p_evidence_digest text,
  p_observed_at timestamptz,
  p_verification_state text,
  p_opened_tickets integer,
  p_resolved_tickets integer,
  p_sla_breached_tickets integer,
  p_open_critical_tickets integer,
  p_first_response_minutes numeric,
  p_resolution_minutes numeric,
  p_csat_bps integer,
  p_actor_id text,
  p_authority_tier text,
  p_idempotency_key text,
  p_request_fingerprint text,
  p_feature_gate_enabled boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_control public.client_success_head_controls%ROWTYPE;
  v_existing public.client_success_support_snapshots%ROWTYPE;
  v_snapshot public.client_success_support_snapshots%ROWTYPE;
BEGIN
  v_control := public.client_success_head_assert_control(
    p_tenant_id, p_feature_gate_enabled
  );
  IF p_actor_id IS DISTINCT FROM v_control.registered_support_adapter_id
     OR p_authority_tier IS DISTINCT FROM 'support_evidence_adapter' THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'client_success_support_adapter_identity_invalid';
  END IF;
  IF p_snapshot_id IS NULL OR p_customer_id IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM public.customers customer
        WHERE customer.id = p_customer_id
          AND customer.tenant_id = p_tenant_id
     )
     OR char_length(COALESCE(p_source_snapshot_id, '')) NOT BETWEEN 2 AND 240
     OR p_source_snapshot_id !~
        '^[A-Za-z0-9][A-Za-z0-9._:/-]{1,239}$'
     OR p_source_snapshot_id LIKE '%@%'
     OR p_evidence_digest !~ '^[a-f0-9]{64}$'
     OR p_observed_at IS NULL
     OR p_observed_at > now() + interval '5 minutes'
     OR p_verification_state NOT IN ('verified', 'unverified')
     OR p_opened_tickets < 0 OR p_resolved_tickets < 0
     OR p_sla_breached_tickets < 0 OR p_open_critical_tickets < 0
     OR p_resolved_tickets > p_opened_tickets
     OR p_sla_breached_tickets > p_opened_tickets
     OR p_first_response_minutes NOT BETWEEN 0 AND 100000
     OR p_resolution_minutes NOT BETWEEN 0 AND 10000000
     OR p_csat_bps NOT BETWEEN 0 AND 10000
     OR char_length(p_idempotency_key) NOT BETWEEN 8 AND 200
     OR p_request_fingerprint !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'client_success_support_snapshot_invalid';
  END IF;
  SELECT snapshot.* INTO v_existing
    FROM public.client_success_support_snapshots snapshot
   WHERE snapshot.tenant_id = p_tenant_id
     AND snapshot.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.request_fingerprint IS DISTINCT FROM p_request_fingerprint
       OR v_existing.id IS DISTINCT FROM p_snapshot_id
       OR v_existing.customer_id IS DISTINCT FROM p_customer_id
       OR v_existing.source_snapshot_id IS DISTINCT FROM p_source_snapshot_id
       OR v_existing.evidence_digest IS DISTINCT FROM p_evidence_digest
       OR v_existing.observed_at IS DISTINCT FROM p_observed_at
       OR v_existing.verification_state IS DISTINCT FROM p_verification_state
       OR v_existing.opened_tickets IS DISTINCT FROM p_opened_tickets
       OR v_existing.resolved_tickets IS DISTINCT FROM p_resolved_tickets
       OR v_existing.sla_breached_tickets IS DISTINCT FROM
          p_sla_breached_tickets
       OR v_existing.open_critical_tickets IS DISTINCT FROM
          p_open_critical_tickets
       OR v_existing.first_response_minutes IS DISTINCT FROM
          p_first_response_minutes
       OR v_existing.resolution_minutes IS DISTINCT FROM p_resolution_minutes
       OR v_existing.csat_bps IS DISTINCT FROM p_csat_bps
       OR v_existing.recorded_by_adapter_id IS DISTINCT FROM p_actor_id THEN
      RAISE EXCEPTION USING ERRCODE = '23505',
        MESSAGE = 'client_success_support_snapshot_idempotency_conflict';
    END IF;
    RETURN jsonb_build_object(
      'outcome', 'replay', 'snapshot', to_jsonb(v_existing)
    );
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.client_success_support_snapshots snapshot
     WHERE snapshot.id = p_snapshot_id
        OR (
          snapshot.source_system = 'support_ledger'
          AND snapshot.source_snapshot_id = p_source_snapshot_id
        )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23505',
      MESSAGE = 'client_success_support_snapshot_identity_conflict';
  END IF;
  INSERT INTO public.client_success_support_snapshots (
    id, tenant_id, customer_id, source_snapshot_id, evidence_digest,
    observed_at, verification_state, opened_tickets, resolved_tickets,
    sla_breached_tickets, open_critical_tickets, first_response_minutes,
    resolution_minutes, csat_bps, recorded_by_adapter_id, idempotency_key,
    request_fingerprint
  ) VALUES (
    p_snapshot_id, p_tenant_id, p_customer_id, p_source_snapshot_id,
    p_evidence_digest, p_observed_at, p_verification_state, p_opened_tickets,
    p_resolved_tickets, p_sla_breached_tickets, p_open_critical_tickets,
    p_first_response_minutes, p_resolution_minutes, p_csat_bps, p_actor_id,
    p_idempotency_key, p_request_fingerprint
  ) RETURNING * INTO v_snapshot;
  RETURN jsonb_build_object(
    'outcome', 'recorded', 'snapshot', to_jsonb(v_snapshot)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.client_success_head_charter_register_rpc(
  p_tenant_id uuid,
  p_version integer,
  p_mission text,
  p_max_first_response_minutes integer,
  p_max_resolution_minutes integer,
  p_max_sla_breach_rate_bps integer,
  p_min_csat_bps integer,
  p_max_open_critical_tickets integer,
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
  v_control public.client_success_head_controls%ROWTYPE;
  v_existing public.client_success_head_charters%ROWTYPE;
  v_charter public.client_success_head_charters%ROWTYPE;
  v_evidence_digest text;
BEGIN
  v_control := public.client_success_head_assert_control(
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
      MESSAGE = 'client_success_head_charter_requires_tenant_owner';
  END IF;
  IF p_version <= 0
     OR char_length(btrim(COALESCE(p_mission, ''))) NOT BETWEEN 40 AND 1000
     OR p_max_first_response_minutes NOT BETWEEN 1 AND 100000
     OR p_max_resolution_minutes NOT BETWEEN 1 AND 10000000
     OR p_max_sla_breach_rate_bps NOT BETWEEN 0 AND 10000
     OR p_min_csat_bps NOT BETWEEN 1 AND 10000
     OR p_max_open_critical_tickets NOT BETWEEN 0 AND 1000000
     OR char_length(p_idempotency_key) NOT BETWEEN 8 AND 200
     OR p_request_fingerprint !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'client_success_head_charter_invalid';
  END IF;
  v_evidence_digest := public.client_success_head_evidence_digest(p_evidence);
  SELECT charter.* INTO v_existing
    FROM public.client_success_head_charters charter
   WHERE charter.tenant_id = p_tenant_id
     AND charter.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.request_fingerprint IS DISTINCT FROM p_request_fingerprint
       OR v_existing.version IS DISTINCT FROM p_version
       OR v_existing.mission IS DISTINCT FROM p_mission
       OR v_existing.max_first_response_minutes IS DISTINCT FROM
          p_max_first_response_minutes
       OR v_existing.max_resolution_minutes IS DISTINCT FROM
          p_max_resolution_minutes
       OR v_existing.max_sla_breach_rate_bps IS DISTINCT FROM
          p_max_sla_breach_rate_bps
       OR v_existing.min_csat_bps IS DISTINCT FROM p_min_csat_bps
       OR v_existing.max_open_critical_tickets IS DISTINCT FROM
          p_max_open_critical_tickets
       OR v_existing.actor_id IS DISTINCT FROM p_actor_id
       OR v_existing.evidence IS DISTINCT FROM p_evidence
       OR v_existing.evidence_digest IS DISTINCT FROM v_evidence_digest THEN
      RAISE EXCEPTION USING ERRCODE = '23505',
        MESSAGE = 'client_success_head_charter_idempotency_conflict';
    END IF;
    RETURN jsonb_build_object(
      'outcome', 'replay', 'charter', to_jsonb(v_existing)
    );
  END IF;
  INSERT INTO public.client_success_head_charters (
    tenant_id, version, mission, max_first_response_minutes,
    max_resolution_minutes, max_sla_breach_rate_bps, min_csat_bps,
    max_open_critical_tickets, evidence, evidence_digest, actor_id,
    idempotency_key, request_fingerprint
  ) VALUES (
    p_tenant_id, p_version, p_mission, p_max_first_response_minutes,
    p_max_resolution_minutes, p_max_sla_breach_rate_bps, p_min_csat_bps,
    p_max_open_critical_tickets, p_evidence, v_evidence_digest, p_actor_id,
    p_idempotency_key, p_request_fingerprint
  ) RETURNING * INTO v_charter;
  RETURN jsonb_build_object(
    'outcome', 'registered', 'charter', to_jsonb(v_charter)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.client_success_head_report_accept_rpc(
  p_tenant_id uuid,
  p_report_id uuid,
  p_charter_id uuid,
  p_customer_id uuid,
  p_health_snapshot_id uuid,
  p_intervention_id uuid,
  p_support_snapshot_id uuid,
  p_period_start date,
  p_period_end date,
  p_actor_id text,
  p_authority_tier text,
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
  v_control public.client_success_head_controls%ROWTYPE;
  v_charter public.client_success_head_charters%ROWTYPE;
  v_snapshot public.client_health_signal_snapshots%ROWTYPE;
  v_support public.client_success_support_snapshots%ROWTYPE;
  v_intervention public.client_health_interventions%ROWTYPE;
  v_existing public.client_success_head_reports%ROWTYPE;
  v_report public.client_success_head_reports%ROWTYPE;
  v_evidence_digest text;
  v_evidence_count integer;
  v_sla_rate integer;
  v_service_health text;
  v_client_outcome text;
BEGIN
  v_control := public.client_success_head_assert_control(
    p_tenant_id, p_feature_gate_enabled
  );
  IF p_actor_id IS DISTINCT FROM v_control.registered_agent_id
     OR p_authority_tier IS DISTINCT FROM 'department_head' THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'client_success_head_report_registered_head_required';
  END IF;
  SELECT charter.* INTO STRICT v_charter
    FROM public.client_success_head_charters charter
   WHERE charter.id = p_charter_id AND charter.tenant_id = p_tenant_id;
  SELECT snapshot.* INTO STRICT v_snapshot
    FROM public.client_health_signal_snapshots snapshot
   WHERE snapshot.id = p_health_snapshot_id
     AND snapshot.tenant_id = p_tenant_id
     AND snapshot.customer_id = p_customer_id;
  SELECT support.* INTO STRICT v_support
    FROM public.client_success_support_snapshots support
   WHERE support.id = p_support_snapshot_id
     AND support.tenant_id = p_tenant_id
     AND support.customer_id = p_customer_id;
  IF p_intervention_id IS NOT NULL THEN
    SELECT intervention.* INTO STRICT v_intervention
      FROM public.client_health_interventions intervention
     WHERE intervention.id = p_intervention_id
       AND intervention.tenant_id = p_tenant_id
       AND intervention.customer_id = p_customer_id;
    IF v_intervention.source_signal_snapshot_id IS DISTINCT FROM
       p_health_snapshot_id THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'client_success_head_intervention_signal_mismatch';
    END IF;
  END IF;
  IF p_report_id IS NULL OR p_customer_id IS NULL
     OR p_period_start IS NULL OR p_period_end < p_period_start
     OR char_length(p_idempotency_key) NOT BETWEEN 8 AND 200
     OR p_request_fingerprint !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'client_success_head_structured_report_invalid';
  END IF;
  v_evidence_digest := public.client_success_head_evidence_digest(p_evidence);
  v_evidence_count := jsonb_array_length(p_evidence->'sources');
  v_sla_rate := CASE WHEN v_support.opened_tickets > 0 THEN
    floor(v_support.sla_breached_tickets::numeric * 10000 /
      v_support.opened_tickets)::integer END;

  -- Support quality and customer outcome are independent dimensions.
  v_service_health := CASE
    WHEN v_support.verification_state <> 'verified'
      THEN 'unverified'
    WHEN v_snapshot.provenance_type <> 'observed'
      OR v_snapshot.outcome_evidence_eligible IS DISTINCT FROM true
      OR v_snapshot.signal_state IN ('unknown', 'unproven')
      THEN 'unverified'
    WHEN v_support.open_critical_tickets >
         v_charter.max_open_critical_tickets
      OR v_support.first_response_minutes >
         v_charter.max_first_response_minutes * 2
      OR v_support.resolution_minutes >
         v_charter.max_resolution_minutes * 2
      OR COALESCE(v_sla_rate, 0) >
         LEAST(10000, v_charter.max_sla_breach_rate_bps * 2)
      THEN 'critical'
    WHEN v_snapshot.signal_state = 'at_risk'
      OR v_support.first_response_minutes >
         v_charter.max_first_response_minutes
      OR v_support.resolution_minutes > v_charter.max_resolution_minutes
      OR COALESCE(v_sla_rate, 0) > v_charter.max_sla_breach_rate_bps
      OR v_support.csat_bps < v_charter.min_csat_bps
      THEN 'at_risk'
    ELSE 'healthy'
  END;

  -- action_completed deliberately remains unproven. Only a separately
  -- recorded and verified outcome, or observed stable signal without an
  -- intervention, may establish an observed client outcome.
  v_client_outcome := CASE
    WHEN v_snapshot.provenance_type <> 'observed'
      OR v_snapshot.outcome_evidence_eligible IS DISTINCT FROM true
      THEN 'unproven'
    WHEN p_intervention_id IS NULL AND v_snapshot.signal_state = 'stable'
      THEN 'observed_stable'
    WHEN p_intervention_id IS NOT NULL
      AND v_intervention.lifecycle_state = 'outcome_recorded'
      AND v_intervention.outcome_verified = true
      THEN v_intervention.outcome_state
    ELSE 'unproven'
  END;

  SELECT report.* INTO v_existing
    FROM public.client_success_head_reports report
   WHERE report.tenant_id = p_tenant_id
     AND report.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.request_fingerprint IS DISTINCT FROM p_request_fingerprint
       OR v_existing.id IS DISTINCT FROM p_report_id
       OR v_existing.charter_id IS DISTINCT FROM p_charter_id
       OR v_existing.customer_id IS DISTINCT FROM p_customer_id
       OR v_existing.health_snapshot_id IS DISTINCT FROM p_health_snapshot_id
       OR v_existing.intervention_id IS DISTINCT FROM p_intervention_id
       OR v_existing.support_snapshot_id IS DISTINCT FROM
          p_support_snapshot_id
       OR v_existing.period_start IS DISTINCT FROM p_period_start
       OR v_existing.period_end IS DISTINCT FROM p_period_end
       OR v_existing.support_source_id IS DISTINCT FROM
          v_support.source_snapshot_id
       OR v_existing.support_evidence_digest IS DISTINCT FROM
          v_support.evidence_digest
       OR v_existing.support_observed_at IS DISTINCT FROM
          v_support.observed_at
       OR v_existing.opened_tickets IS DISTINCT FROM
          v_support.opened_tickets
       OR v_existing.resolved_tickets IS DISTINCT FROM
          v_support.resolved_tickets
       OR v_existing.sla_breached_tickets IS DISTINCT FROM
          v_support.sla_breached_tickets
       OR v_existing.open_critical_tickets IS DISTINCT FROM
          v_support.open_critical_tickets
       OR v_existing.first_response_minutes IS DISTINCT FROM
          v_support.first_response_minutes
       OR v_existing.resolution_minutes IS DISTINCT FROM
          v_support.resolution_minutes
       OR v_existing.csat_bps IS DISTINCT FROM v_support.csat_bps
       OR v_existing.accepted_by_head_id IS DISTINCT FROM p_actor_id
       OR v_existing.accepted_authority_tier IS DISTINCT FROM
          p_authority_tier
       OR v_existing.evidence IS DISTINCT FROM p_evidence
       OR v_existing.evidence_digest IS DISTINCT FROM v_evidence_digest THEN
      RAISE EXCEPTION USING ERRCODE = '23505',
        MESSAGE = 'client_success_head_report_idempotency_conflict';
    END IF;
    RETURN jsonb_build_object(
      'outcome', 'replay', 'report', to_jsonb(v_existing)
    );
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.client_success_head_reports report
     WHERE report.id = p_report_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23505',
      MESSAGE = 'client_success_head_report_identity_conflict';
  END IF;
  INSERT INTO public.client_success_head_reports (
    id, tenant_id, charter_id, customer_id, health_snapshot_id,
    intervention_id, period_start, period_end, support_snapshot_id,
    support_source_id,
    support_evidence_digest, support_observed_at, opened_tickets,
    resolved_tickets, sla_breached_tickets, open_critical_tickets,
    first_response_minutes, resolution_minutes, csat_bps,
    sla_breach_rate_bps, service_health, client_outcome_state,
    evidence, evidence_count, evidence_digest, accepted_by_head_id,
    accepted_authority_tier, idempotency_key, request_fingerprint
  ) VALUES (
    p_report_id, p_tenant_id, p_charter_id, p_customer_id,
    p_health_snapshot_id, p_intervention_id, p_period_start, p_period_end,
    p_support_snapshot_id, v_support.source_snapshot_id,
    v_support.evidence_digest, v_support.observed_at,
    v_support.opened_tickets, v_support.resolved_tickets,
    v_support.sla_breached_tickets, v_support.open_critical_tickets,
    v_support.first_response_minutes, v_support.resolution_minutes,
    v_support.csat_bps, v_sla_rate, v_service_health,
    v_client_outcome, p_evidence, v_evidence_count, v_evidence_digest,
    p_actor_id, p_authority_tier, p_idempotency_key, p_request_fingerprint
  ) RETURNING * INTO v_report;
  RETURN jsonb_build_object(
    'outcome', 'accepted', 'report', to_jsonb(v_report)
  );
EXCEPTION
  WHEN no_data_found THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'client_success_head_authoritative_evidence_not_found';
END;
$$;

CREATE OR REPLACE FUNCTION public.client_success_head_work_command_rpc(
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
  v_control public.client_success_head_controls%ROWTYPE;
  v_item public.client_success_head_items%ROWTYPE;
  v_existing public.client_success_head_events%ROWTYPE;
  v_event public.client_success_head_events%ROWTYPE;
  v_evidence_digest text;
  v_semantic_fingerprint text;
  v_previous_status text;
  v_resulting_status text;
  v_event_type text;
  v_actor_uuid uuid;
  v_assignee_uuid uuid;
BEGIN
  v_control := public.client_success_head_assert_control(
    p_tenant_id, p_feature_gate_enabled
  );
  IF p_command NOT IN (
    'create', 'accept', 'start', 'escalate', 'complete', 'record_decision'
  ) OR p_expected_revision < 0 THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'client_success_head_command_invalid';
  END IF;
  IF (p_command <> 'escalate' AND p_escalation_code IS NOT NULL)
     OR (
       p_command NOT IN ('complete', 'record_decision')
       AND p_completion_evidence_digest IS NOT NULL
     )
     OR (p_command <> 'record_decision' AND p_decision IS NOT NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'client_success_head_command_fields_forbidden';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.client_success_head_reports report
     WHERE report.id = p_report_id AND report.tenant_id = p_tenant_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'client_success_head_report_not_accepted_for_tenant';
  END IF;
  IF p_actor_type = 'agent' THEN
    IF p_authority_tier <> 'department_head'
       OR p_actor_id IS DISTINCT FROM v_control.registered_agent_id THEN
      RAISE EXCEPTION USING ERRCODE = '42501',
        MESSAGE = 'client_success_head_agent_identity_invalid';
    END IF;
  ELSIF p_actor_type = 'human' THEN
    BEGIN
      v_actor_uuid := p_actor_id::uuid;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION USING ERRCODE = '42501',
        MESSAGE = 'client_success_head_owner_identity_invalid';
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
        MESSAGE = 'client_success_head_owner_identity_invalid';
    END IF;
  ELSIF p_actor_type = 'system' THEN
    IF p_actor_id IS NOT NULL OR p_authority_tier <> 'system' THEN
      RAISE EXCEPTION USING ERRCODE = '42501',
        MESSAGE = 'client_success_head_system_identity_invalid';
    END IF;
  ELSE
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'client_success_head_actor_invalid';
  END IF;
  v_evidence_digest := public.client_success_head_evidence_digest(p_evidence);
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
    FROM public.client_success_head_events event
   WHERE event.tenant_id = p_tenant_id
     AND event.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.request_fingerprint IS DISTINCT FROM p_request_fingerprint
       OR v_existing.semantic_fingerprint IS DISTINCT FROM
          v_semantic_fingerprint THEN
      RAISE EXCEPTION USING ERRCODE = '23505',
        MESSAGE = 'client_success_head_work_idempotency_conflict';
    END IF;
    RETURN jsonb_build_object(
      'outcome', 'replay',
      'item', (
        SELECT to_jsonb(item) FROM public.client_success_head_items item
         WHERE item.id = p_item_id AND item.tenant_id = p_tenant_id
      ),
      'event', to_jsonb(v_existing)
    );
  END IF;
  IF p_command = 'create' THEN
    IF p_expected_revision <> 0
       OR p_item_kind NOT IN ('goal', 'work', 'decision', 'exception')
       OR p_action_scope NOT IN (
         'analyze_client_health', 'track_client_goal',
         'recommend_intervention', 'request_owner_decision',
         'raise_client_exception', 'verify_support_evidence'
       )
       OR char_length(btrim(COALESCE(p_title, ''))) NOT BETWEEN 3 AND 240
       OR p_assignee_type NOT IN ('agent', 'human')
       OR char_length(btrim(COALESCE(p_assignee_id, ''))) NOT BETWEEN 2 AND 160
       OR p_due_at IS NULL OR p_due_at < now()
       OR (p_item_kind = 'goal' AND p_action_scope <> 'track_client_goal')
       OR (
         p_item_kind = 'decision'
         AND p_action_scope <> 'request_owner_decision'
       )
       OR (
         p_item_kind = 'exception'
         AND p_action_scope <> 'raise_client_exception'
       )
       OR (
         p_item_kind = 'work'
         AND p_action_scope NOT IN (
           'analyze_client_health', 'recommend_intervention',
           'verify_support_evidence'
         )
       ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'client_success_head_supervised_scope_invalid';
    END IF;
    IF p_assignee_type = 'agent' THEN
      IF p_assignee_id IS DISTINCT FROM v_control.registered_agent_id THEN
        RAISE EXCEPTION USING ERRCODE = '42501',
          MESSAGE = 'client_success_head_assignee_identity_invalid';
      END IF;
    ELSE
      BEGIN
        v_assignee_uuid := p_assignee_id::uuid;
      EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION USING ERRCODE = '42501',
          MESSAGE = 'client_success_head_assignee_identity_invalid';
      END;
      IF NOT EXISTS (
        SELECT 1 FROM public.tenant_users tenant_user
         WHERE tenant_user.tenant_id = p_tenant_id
           AND tenant_user.user_id = v_assignee_uuid
      ) THEN
        RAISE EXCEPTION USING ERRCODE = '42501',
          MESSAGE = 'client_success_head_assignee_identity_invalid';
      END IF;
    END IF;
    IF p_item_kind = 'decision' AND (
      p_assignee_type <> 'human' OR NOT EXISTS (
        SELECT 1 FROM public.tenant_users tenant_user
         WHERE tenant_user.tenant_id = p_tenant_id
           AND tenant_user.user_id = v_assignee_uuid
           AND tenant_user.role IN (
             'owner', 'platform_owner', 'founder', 'admin',
             'client_owner', 'tenant_owner'
           )
      )
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '42501',
        MESSAGE = 'client_success_head_decision_requires_human_owner';
    END IF;
    INSERT INTO public.client_success_head_items (
      id, tenant_id, report_id, item_kind, action_scope, title,
      assignee_type, assignee_id, due_at, decision_state
    ) VALUES (
      p_item_id, p_tenant_id, p_report_id, p_item_kind, p_action_scope,
      p_title, p_assignee_type, p_assignee_id, p_due_at,
      CASE WHEN p_item_kind = 'decision' THEN 'pending'
        ELSE 'not_applicable' END
    ) RETURNING * INTO v_item;
    v_previous_status := NULL;
    v_resulting_status := 'assigned';
    v_event_type := 'assigned';
  ELSE
    IF p_item_kind IS NOT NULL OR p_action_scope IS NOT NULL
       OR p_title IS NOT NULL OR p_assignee_type IS NOT NULL
       OR p_assignee_id IS NOT NULL OR p_due_at IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'client_success_head_create_fields_forbidden';
    END IF;
    SELECT item.* INTO STRICT v_item
      FROM public.client_success_head_items item
     WHERE item.id = p_item_id AND item.tenant_id = p_tenant_id
       AND item.report_id = p_report_id
     FOR UPDATE;
    IF v_item.revision IS DISTINCT FROM p_expected_revision THEN
      RAISE EXCEPTION USING ERRCODE = '40001',
        MESSAGE = 'client_success_head_item_revision_conflict';
    END IF;
    v_previous_status := v_item.status;
    IF p_command = 'accept' THEN
      IF v_item.status <> 'assigned'
         OR p_actor_type IS DISTINCT FROM v_item.assignee_type
         OR p_actor_id IS DISTINCT FROM v_item.assignee_id THEN
        RAISE EXCEPTION USING ERRCODE = '42501',
          MESSAGE = 'client_success_head_acceptance_contract_invalid';
      END IF;
      UPDATE public.client_success_head_items SET
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
          MESSAGE = 'client_success_head_start_contract_invalid';
      END IF;
      UPDATE public.client_success_head_items SET
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
          MESSAGE = 'client_success_head_escalation_contract_invalid';
      END IF;
      UPDATE public.client_success_head_items SET
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
          MESSAGE = 'client_success_head_completion_contract_invalid';
      END IF;
      UPDATE public.client_success_head_items SET
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
          MESSAGE = 'client_success_head_owner_decision_contract_invalid';
      END IF;
      UPDATE public.client_success_head_items SET
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
  INSERT INTO public.client_success_head_events (
    tenant_id, item_id, report_id, event_type, previous_status,
    resulting_status, expected_revision, resulting_revision,
    actor_type, actor_id, authority_tier, evidence, evidence_digest,
    idempotency_key, request_fingerprint, semantic_fingerprint
  ) VALUES (
    p_tenant_id, p_item_id, p_report_id, v_event_type, v_previous_status,
    v_resulting_status, p_expected_revision, v_item.revision,
    p_actor_type, p_actor_id, p_authority_tier, p_evidence,
    v_evidence_digest, p_idempotency_key, p_request_fingerprint,
    v_semantic_fingerprint
  ) RETURNING * INTO v_event;
  RETURN jsonb_build_object(
    'outcome', 'applied', 'item', to_jsonb(v_item), 'event', to_jsonb(v_event)
  );
EXCEPTION
  WHEN no_data_found THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'client_success_head_item_not_found';
END;
$$;

CREATE OR REPLACE FUNCTION public.client_success_head_kill_switch_rpc(
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
  v_control public.client_success_head_controls%ROWTYPE;
BEGIN
  v_claims := NULLIF(current_setting('request.jwt.claims', true), '');
  v_calling_role := COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    CASE WHEN v_claims IS NOT NULL THEN v_claims::jsonb ->> 'role' END,
    session_user::text
  );
  IF v_calling_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'client_success_head_kill_switch_requires_service_role';
  END IF;
  IF p_tenant_id IS NULL
     OR btrim(COALESCE(p_reason, '')) !~ '^[a-z][a-z0-9_:-]{2,79}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'client_success_head_kill_switch_reason_invalid';
  END IF;
  UPDATE public.client_success_head_controls SET
    enabled = false, execution_mode = 'disabled', kill_switch_engaged = true,
    activation_evidence = activation_evidence || jsonb_build_object(
      'kill_switch_reason_digest',
      encode(digest(btrim(p_reason), 'sha256'), 'hex'),
      'kill_switch_engaged_at', now()
    )
  WHERE tenant_id = p_tenant_id
  RETURNING * INTO v_control;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002',
      MESSAGE = 'client_success_head_control_not_found';
  END IF;
  RETURN jsonb_build_object(
    'outcome', 'kill_switch_engaged',
    'tenant_id', v_control.tenant_id, 'revision', v_control.revision
  );
END;
$$;

REVOKE ALL ON FUNCTION public.client_success_head_evidence_digest(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.client_success_head_assert_control(uuid, boolean)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.client_success_support_snapshot_record_rpc(
  uuid, uuid, uuid, text, text, timestamptz, text, integer, integer,
  integer, integer, numeric, numeric, integer, text, text, text, text, boolean
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.client_success_head_charter_register_rpc(
  uuid, integer, text, integer, integer, integer, integer, integer,
  uuid, jsonb, text, text, boolean
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.client_success_head_report_accept_rpc(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, date, date, text, text, jsonb,
  text, text, boolean
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.client_success_head_work_command_rpc(
  uuid, uuid, uuid, text, bigint, text, text, text, jsonb, text, text,
  boolean, text, text, text, text, text, timestamptz, text, text, text
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.client_success_head_kill_switch_rpc(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.client_success_head_charter_register_rpc(
  uuid, integer, text, integer, integer, integer, integer, integer,
  uuid, jsonb, text, text, boolean
) TO service_role;
GRANT EXECUTE ON FUNCTION public.client_success_support_snapshot_record_rpc(
  uuid, uuid, uuid, text, text, timestamptz, text, integer, integer,
  integer, integer, numeric, numeric, integer, text, text, text, text, boolean
) TO service_role;
GRANT EXECUTE ON FUNCTION public.client_success_head_report_accept_rpc(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, date, date, text, text, jsonb,
  text, text, boolean
) TO service_role;
GRANT EXECUTE ON FUNCTION public.client_success_head_work_command_rpc(
  uuid, uuid, uuid, text, bigint, text, text, text, jsonb, text, text,
  boolean, text, text, text, text, text, timestamptz, text, text, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.client_success_head_kill_switch_rpc(uuid, text)
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.client_success_head_immutable_row()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.client_success_head_item_identity_guard()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.client_success_head_control_guard()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.client_success_support_snapshot_tenant_guard()
  FROM PUBLIC, anon, authenticated, service_role;
