-- ============================================================================
-- Migration 068: Canonical work-item control-plane foundation (G01)
-- Date: 2026-07-24
--
-- Additive, inert-by-default storage for decisions, actions, reviews,
-- incidents, handoffs, and tasks. No route or worker writes these tables until
-- BOTH existing Autonomous OS flags are explicitly enabled:
--   FGA_OS_CONTROL_PLANE_API_ENABLED=true
--   FGA_OS_DECISION_QUEUE_WRITES_ENABLED=true
--
-- This migration intentionally does not modify or replace attention_queue.
-- Existing attention rows may be projected into work_items through the
-- nullable attention_queue_id compatibility reference.
--
-- ROLLBACK: db/rollbacks/068_work_items_control_plane_rollback.sql
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.work_items (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  schema_version           integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  kind                     text NOT NULL
                             CHECK (kind IN ('decision', 'action', 'review', 'incident', 'handoff', 'task')),
  department               text NOT NULL CHECK (char_length(department) BETWEEN 1 AND 80),
  title                    text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 240),
  summary                  text,
  status                   text NOT NULL DEFAULT 'open'
                             CHECK (status IN (
                               'open', 'claimed', 'in_progress',
                               'awaiting_verification', 'verified',
                               'dismissed', 'cancelled'
                             )),
  priority                 text NOT NULL DEFAULT 'normal'
                             CHECK (priority IN ('critical', 'high', 'normal', 'low')),
  priority_rank            smallint GENERATED ALWAYS AS (
                             CASE priority
                               WHEN 'critical' THEN 0
                               WHEN 'high' THEN 1
                               WHEN 'normal' THEN 2
                               ELSE 3
                             END
                           ) STORED,
  authority_tier           text NOT NULL DEFAULT 'owner'
                             CHECK (authority_tier IN (
                               'system', 'department_head', 'chief_of_staff', 'owner'
                             )),
  assignee_type            text NOT NULL DEFAULT 'unassigned'
                             CHECK (assignee_type IN ('unassigned', 'human', 'agent', 'service')),
  assignee_id              text,

  -- Stable source identity and dedupe. Source IDs are text because not every
  -- producer uses UUIDs (provider event IDs and derived controls may not).
  source_type              text NOT NULL CHECK (char_length(source_type) BETWEEN 1 AND 80),
  source_id                text NOT NULL CHECK (char_length(source_id) BETWEEN 1 AND 240),
  entity_type              text,
  entity_id                text,
  idempotency_key          text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  attention_queue_id       uuid REFERENCES public.attention_queue(id) ON DELETE SET NULL,

  -- Action protocol is descriptive only in this foundation. It grants no
  -- permission and cannot be executed without separately gated application
  -- code and authority evaluation.
  action_protocol          jsonb NOT NULL DEFAULT '{}'::jsonb,
  acceptance_criteria      jsonb NOT NULL DEFAULT '{}'::jsonb,
  verification_state       text NOT NULL DEFAULT 'pending'
                             CHECK (verification_state IN ('pending', 'passed', 'failed', 'not_required')),
  verification_evidence    jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason_code              text,

  sla_started_at           timestamptz NOT NULL DEFAULT now(),
  due_at                   timestamptz,
  claimed_at               timestamptz,
  started_at               timestamptz,
  submitted_for_verification_at timestamptz,
  verified_at              timestamptz,
  resolved_at              timestamptz,
  created_by_type          text NOT NULL DEFAULT 'system'
                             CHECK (created_by_type IN ('human', 'agent', 'service', 'system')),
  created_by_id            text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  revision                 integer NOT NULL DEFAULT 1 CHECK (revision > 0),

  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, idempotency_key),
  CHECK (
    (assignee_type = 'unassigned' AND assignee_id IS NULL)
    OR (assignee_type <> 'unassigned' AND assignee_id IS NOT NULL)
  ),
  CHECK (due_at IS NULL OR due_at >= sla_started_at),
  CHECK (
    (status = 'verified' AND verification_state IN ('passed', 'not_required') AND verified_at IS NOT NULL)
    OR status <> 'verified'
  ),
  CHECK (
    (status IN ('verified', 'dismissed', 'cancelled') AND resolved_at IS NOT NULL)
    OR status NOT IN ('verified', 'dismissed', 'cancelled')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_work_items_attention_compat
  ON public.work_items (attention_queue_id)
  WHERE attention_queue_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_work_items_tenant_open
  ON public.work_items (tenant_id, priority_rank, due_at, created_at DESC)
  WHERE status NOT IN ('verified', 'dismissed', 'cancelled');

CREATE INDEX IF NOT EXISTS idx_work_items_tenant_department
  ON public.work_items (tenant_id, department, status, due_at);

CREATE INDEX IF NOT EXISTS idx_work_items_source
  ON public.work_items (tenant_id, source_type, source_id);

CREATE TABLE IF NOT EXISTS public.work_item_events (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  work_item_id             uuid NOT NULL,
  schema_version           integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  event_type               text NOT NULL CHECK (char_length(event_type) BETWEEN 1 AND 80),
  from_status              text,
  to_status                text,
  actor_type               text NOT NULL
                             CHECK (actor_type IN ('human', 'agent', 'service', 'system')),
  actor_id                 text,
  authority_tier           text NOT NULL
                             CHECK (authority_tier IN (
                               'system', 'department_head', 'chief_of_staff', 'owner'
                             )),
  reason_code              text,
  idempotency_key          text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  request_fingerprint      text NOT NULL CHECK (char_length(request_fingerprint) BETWEEN 16 AND 128),
  evidence                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at              timestamptz NOT NULL DEFAULT now(),
  created_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (work_item_id, tenant_id)
    REFERENCES public.work_items(id, tenant_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_work_item_events_item_time
  ON public.work_item_events (work_item_id, occurred_at, id);

CREATE INDEX IF NOT EXISTS idx_work_item_events_tenant_time
  ON public.work_item_events (tenant_id, occurred_at DESC);

-- Database-level audit is separate from domain events. It records every
-- mutation even if a future service-role caller forgets to append a domain
-- event. No application route should ever update or delete this table.
CREATE TABLE IF NOT EXISTS public.work_item_audit_log (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  work_item_id             uuid NOT NULL,
  action                   text NOT NULL CHECK (action IN ('INSERT', 'UPDATE', 'DELETE')),
  actor_id                 text,
  actor_label              text,
  before_row               jsonb,
  after_row                jsonb,
  changed_fields           text[],
  audited_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_work_item_audit_item_time
  ON public.work_item_audit_log (work_item_id, audited_at DESC);

CREATE INDEX IF NOT EXISTS idx_work_item_audit_tenant_time
  ON public.work_item_audit_log (tenant_id, audited_at DESC);

CREATE OR REPLACE FUNCTION public.work_items_set_revision()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  NEW.revision := OLD.revision + 1;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public.work_items_tenant_guard()
RETURNS trigger AS $$
BEGIN
  IF NEW.attention_queue_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.attention_queue
     WHERE id = NEW.attention_queue_id AND tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'work item attention tenant mismatch';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_work_items_tenant_guard ON public.work_items;
CREATE TRIGGER trg_work_items_tenant_guard
  BEFORE INSERT OR UPDATE ON public.work_items
  FOR EACH ROW EXECUTE FUNCTION public.work_items_tenant_guard();

DROP TRIGGER IF EXISTS trg_work_items_set_revision ON public.work_items;
CREATE TRIGGER trg_work_items_set_revision
  BEFORE UPDATE ON public.work_items
  FOR EACH ROW EXECUTE FUNCTION public.work_items_set_revision();

CREATE OR REPLACE FUNCTION public.work_items_audit_trigger()
RETURNS trigger AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_tenant uuid;
  v_item uuid;
  v_changed text[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_before := NULL;
    v_after := to_jsonb(NEW);
    v_tenant := NEW.tenant_id;
    v_item := NEW.id;
    v_changed := NULL;
  ELSIF TG_OP = 'UPDATE' THEN
    v_before := to_jsonb(OLD);
    v_after := to_jsonb(NEW);
    v_tenant := NEW.tenant_id;
    v_item := NEW.id;
    SELECT array_agg(key ORDER BY key)
      INTO v_changed
      FROM jsonb_each(v_before)
     WHERE v_before -> key IS DISTINCT FROM v_after -> key;
  ELSE
    v_before := to_jsonb(OLD);
    v_after := NULL;
    v_tenant := OLD.tenant_id;
    v_item := OLD.id;
    v_changed := NULL;
  END IF;

  INSERT INTO public.work_item_audit_log (
    tenant_id, work_item_id, action, actor_id, actor_label,
    before_row, after_row, changed_fields
  ) VALUES (
    v_tenant,
    v_item,
    TG_OP,
    nullif(current_setting('app.actor_id', true), ''),
    nullif(current_setting('app.actor_label', true), ''),
    v_before,
    v_after,
    v_changed
  );

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_work_items_audit ON public.work_items;
CREATE TRIGGER trg_work_items_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.work_items
  FOR EACH ROW EXECUTE FUNCTION public.work_items_audit_trigger();

CREATE OR REPLACE FUNCTION public.autonomous_os_immutable_row()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_work_item_events_immutable
  ON public.work_item_events;
CREATE TRIGGER trg_work_item_events_immutable
  BEFORE UPDATE OR DELETE ON public.work_item_events
  FOR EACH ROW EXECUTE FUNCTION public.autonomous_os_immutable_row();

DROP TRIGGER IF EXISTS trg_work_item_audit_immutable
  ON public.work_item_audit_log;
CREATE TRIGGER trg_work_item_audit_immutable
  BEFORE UPDATE OR DELETE ON public.work_item_audit_log
  FOR EACH ROW EXECUTE FUNCTION public.autonomous_os_immutable_row();

ALTER TABLE public.work_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.work_item_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.work_item_audit_log ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'work_items'
       AND policyname = 'tenant_iso_work_items'
  ) THEN
    CREATE POLICY tenant_iso_work_items
      ON public.work_items
      FOR SELECT
      USING (
        tenant_id = NULLIF(auth.jwt()->'app_metadata'->>'tenant_id', '')::uuid
        AND auth.jwt()->'app_metadata'->>'role'
          IN (
            'owner', 'platform_owner', 'founder', 'admin',
            'client_owner', 'tenant_owner'
          )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'work_item_events'
       AND policyname = 'tenant_iso_work_item_events'
  ) THEN
    CREATE POLICY tenant_iso_work_item_events
      ON public.work_item_events
      FOR SELECT
      USING (
        tenant_id = NULLIF(auth.jwt()->'app_metadata'->>'tenant_id', '')::uuid
        AND auth.jwt()->'app_metadata'->>'role'
          IN (
            'owner', 'platform_owner', 'founder', 'admin',
            'client_owner', 'tenant_owner'
          )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'work_item_audit_log'
       AND policyname = 'tenant_iso_work_item_audit_log'
  ) THEN
    CREATE POLICY tenant_iso_work_item_audit_log
      ON public.work_item_audit_log
      FOR SELECT
      USING (
        tenant_id = NULLIF(auth.jwt()->'app_metadata'->>'tenant_id', '')::uuid
        AND auth.jwt()->'app_metadata'->>'role'
          IN (
            'owner', 'platform_owner', 'founder', 'admin',
            'client_owner', 'tenant_owner'
          )
      );
  END IF;
END $$;

GRANT SELECT ON
  public.work_items,
  public.work_item_events,
  public.work_item_audit_log
TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON
  public.work_items,
  public.work_item_events,
  public.work_item_audit_log
FROM authenticated;
