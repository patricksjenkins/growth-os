-- ============================================================================
-- Migration 075: Work-item identity and relationship hardening
-- Date: 2026-07-24
--
-- Forward hardening for databases that already applied migration 072. This
-- validates human actor/assignee membership transactionally, rejects
-- unregistered agent assignment, validates supported entity links within the
-- tenant, and gives every transition back to open explicit release semantics.
--
-- ROLLBACK: db/rollbacks/075_work_item_identity_hardening_rollback.sql
-- ============================================================================

-- The service role may inspect the ledger, but all mutations must pass through
-- the SECURITY DEFINER command RPCs where feature gates, optimistic revision,
-- idempotency, actor authority, and tenant binding are checked transactionally.
GRANT SELECT ON
  public.work_items,
  public.work_item_events,
  public.work_item_audit_log
TO service_role;
REVOKE INSERT, UPDATE, DELETE ON
  public.work_items,
  public.work_item_events,
  public.work_item_audit_log
FROM service_role;

CREATE OR REPLACE FUNCTION public.work_items_identity_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_uuid uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status = 'open' AND OLD.status <> 'open' THEN
    NEW.assignee_type := 'unassigned';
    NEW.assignee_id := NULL;
    NEW.claimed_at := NULL;
  END IF;

  IF TG_OP = 'INSERT' AND NEW.created_by_type = 'human' THEN
    IF NEW.created_by_id IS NULL
       OR NEW.created_by_id !~
         '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'work_item_human_creator_invalid';
    END IF;
    v_uuid := NEW.created_by_id::uuid;
    IF NOT EXISTS (
      SELECT 1 FROM public.tenant_users tenant_user
       WHERE tenant_user.tenant_id = NEW.tenant_id
         AND tenant_user.user_id = v_uuid
         AND tenant_user.role IN (
           'owner', 'platform_owner', 'founder', 'admin',
           'client_owner', 'tenant_owner'
         )
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'work_item_human_creator_not_current_tenant_owner';
    END IF;
  END IF;

  IF (
    TG_OP = 'INSERT'
    OR NEW.assignee_type IS DISTINCT FROM OLD.assignee_type
    OR NEW.assignee_id IS DISTINCT FROM OLD.assignee_id
  ) AND NEW.assignee_type = 'human' THEN
    IF NEW.assignee_id IS NULL
       OR NEW.assignee_id !~
         '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'work_item_human_assignee_invalid';
    END IF;
    v_uuid := NEW.assignee_id::uuid;
    IF NOT EXISTS (
      SELECT 1 FROM public.tenant_users tenant_user
       WHERE tenant_user.tenant_id = NEW.tenant_id
         AND tenant_user.user_id = v_uuid
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'work_item_human_assignee_not_in_tenant';
    END IF;
  ELSIF (
    TG_OP = 'INSERT'
    OR NEW.assignee_type IS DISTINCT FROM OLD.assignee_type
    OR NEW.assignee_id IS DISTINCT FROM OLD.assignee_id
  ) AND NEW.assignee_type IN ('agent', 'service') THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'work_item_assignee_registry_not_established';
  END IF;

  IF (
    TG_OP = 'INSERT'
    OR NEW.entity_type IS DISTINCT FROM OLD.entity_type
    OR NEW.entity_id IS DISTINCT FROM OLD.entity_id
  ) AND (NEW.entity_type IS NULL) IS DISTINCT FROM (NEW.entity_id IS NULL) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'work_item_entity_link_incomplete';
  END IF;
  IF (
    TG_OP = 'INSERT'
    OR NEW.entity_type IS DISTINCT FROM OLD.entity_type
    OR NEW.entity_id IS DISTINCT FROM OLD.entity_id
  ) AND NEW.entity_type IS NOT NULL THEN
    IF NEW.entity_id !~
       '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'work_item_entity_id_invalid';
    END IF;
    v_uuid := NEW.entity_id::uuid;
    IF (
      NEW.entity_type = 'lead'
      AND NOT EXISTS (
        SELECT 1 FROM public.leads entity
         WHERE entity.id = v_uuid AND entity.tenant_id = NEW.tenant_id
      )
    ) OR (
      NEW.entity_type = 'customer'
      AND NOT EXISTS (
        SELECT 1 FROM public.customers entity
         WHERE entity.id = v_uuid AND entity.tenant_id = NEW.tenant_id
      )
    ) OR (
      NEW.entity_type = 'attention_queue'
      AND NOT EXISTS (
        SELECT 1 FROM public.attention_queue entity
         WHERE entity.id = v_uuid AND entity.tenant_id = NEW.tenant_id
      )
    ) OR (
      NEW.entity_type = 'ops_incident'
      AND NOT EXISTS (
        SELECT 1 FROM public.ops_incidents entity
         WHERE entity.id = v_uuid AND entity.tenant_id = NEW.tenant_id
      )
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'work_item_entity_not_found_for_tenant';
    END IF;
    IF NEW.entity_type NOT IN (
      'lead', 'customer', 'attention_queue', 'ops_incident'
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'work_item_entity_type_not_supported';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_work_items_identity_guard ON public.work_items;
CREATE TRIGGER trg_work_items_identity_guard
  BEFORE INSERT OR UPDATE ON public.work_items
  FOR EACH ROW EXECUTE FUNCTION public.work_items_identity_guard();
REVOKE EXECUTE ON FUNCTION public.work_items_identity_guard()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.work_item_events_identity_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor_uuid uuid;
BEGIN
  IF NEW.actor_type = 'human' THEN
    IF NEW.actor_id IS NULL
       OR NEW.actor_id !~
         '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'work_item_human_actor_invalid';
    END IF;
    v_actor_uuid := NEW.actor_id::uuid;
    IF NOT EXISTS (
      SELECT 1 FROM public.tenant_users tenant_user
       WHERE tenant_user.tenant_id = NEW.tenant_id
         AND tenant_user.user_id = v_actor_uuid
         AND tenant_user.role IN (
           'owner', 'platform_owner', 'founder', 'admin',
           'client_owner', 'tenant_owner'
         )
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'work_item_human_actor_not_current_tenant_owner';
    END IF;
  ELSIF NEW.actor_type = 'agent' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'work_item_agent_registry_not_established';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_work_item_events_identity_guard
  ON public.work_item_events;
CREATE TRIGGER trg_work_item_events_identity_guard
  BEFORE INSERT ON public.work_item_events
  FOR EACH ROW EXECUTE FUNCTION public.work_item_events_identity_guard();
REVOKE EXECUTE ON FUNCTION public.work_item_events_identity_guard()
  FROM PUBLIC, anon, authenticated, service_role;
