-- ============================================================================
-- Migration 072: Atomic, service-role-only work-item command RPCs
-- Date: 2026-07-24
--
-- Adds a typed command boundary over migration 068. Each RPC runs the item
-- mutation, immutable domain event, and trigger-driven audit row in one
-- PostgreSQL transaction. The functions make no external calls.
--
-- ROLLBACK: db/rollbacks/072_work_item_atomic_rpcs_rollback.sql
-- ============================================================================

CREATE OR REPLACE FUNCTION public.work_item_create_rpc(
  p_tenant_id uuid,
  p_kind text,
  p_department text,
  p_title text,
  p_source_type text,
  p_source_id text,
  p_idempotency_key text,
  p_request_fingerprint text,
  p_actor_type text,
  p_actor_id text,
  p_actor_authority_tier text,
  p_summary text DEFAULT NULL,
  p_priority text DEFAULT 'normal',
  p_required_authority_tier text DEFAULT 'owner',
  p_assignee_type text DEFAULT 'unassigned',
  p_assignee_id text DEFAULT NULL,
  p_entity_type text DEFAULT NULL,
  p_entity_id text DEFAULT NULL,
  p_attention_queue_id uuid DEFAULT NULL,
  p_action_protocol jsonb DEFAULT '{}'::jsonb,
  p_acceptance_criteria jsonb DEFAULT '{}'::jsonb,
  p_due_at timestamptz DEFAULT NULL,
  p_sla_started_at timestamptz DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_claims text;
  v_calling_role text;
  v_event public.work_item_events%ROWTYPE;
  v_item public.work_items%ROWTYPE;
  v_actor_label text;
BEGIN
  -- SECURITY DEFINER changes current_user, so bind authorization to the JWT
  -- role (PostgREST) or session_user (direct service-role maintenance).
  v_claims := NULLIF(current_setting('request.jwt.claims', true), '');
  v_calling_role := COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    CASE WHEN v_claims IS NOT NULL THEN v_claims::jsonb ->> 'role' END,
    session_user::text
  );
  IF v_calling_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'work_item_rpc_requires_service_role';
  END IF;

  IF p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'tenant_id_required';
  END IF;
  IF p_actor_type IS NULL
     OR p_actor_type NOT IN ('human', 'agent', 'service', 'system') THEN
    RAISE EXCEPTION 'invalid_actor_type';
  END IF;
  IF p_actor_authority_tier IS NULL
     OR p_actor_authority_tier NOT IN (
       'system', 'department_head', 'chief_of_staff', 'owner'
     ) THEN
    RAISE EXCEPTION 'invalid_actor_authority_tier';
  END IF;
  IF p_actor_type <> 'system' AND NULLIF(btrim(p_actor_id), '') IS NULL THEN
    RAISE EXCEPTION 'actor_id_required';
  END IF;
  IF p_actor_type = 'agent' AND p_actor_authority_tier = 'owner' THEN
    RAISE EXCEPTION 'agent_owner_authority_forbidden';
  END IF;
  IF p_actor_type IN ('service', 'system')
     AND p_actor_authority_tier <> 'system' THEN
    RAISE EXCEPTION 'service_or_system_authority_must_be_system';
  END IF;
  IF p_request_fingerprint IS NULL
     OR char_length(p_request_fingerprint) NOT BETWEEN 16 AND 128 THEN
    RAISE EXCEPTION 'invalid_request_fingerprint';
  END IF;
  IF p_idempotency_key IS NULL
     OR char_length(p_idempotency_key) NOT BETWEEN 8 AND 200 THEN
    RAISE EXCEPTION 'invalid_idempotency_key';
  END IF;
  IF jsonb_typeof(COALESCE(p_action_protocol, '{}'::jsonb)) <> 'object'
     OR jsonb_typeof(COALESCE(p_acceptance_criteria, '{}'::jsonb)) <> 'object' THEN
    RAISE EXCEPTION 'work_item_json_fields_must_be_objects';
  END IF;

  -- Serialize equal tenant/key commands so concurrent retries become a replay,
  -- never a partially-created item or an unclassified unique-key failure.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_tenant_id::text || ':' || p_idempotency_key, 0)
  );

  SELECT e.*
    INTO v_event
    FROM public.work_item_events e
   WHERE e.tenant_id = p_tenant_id
     AND e.idempotency_key = p_idempotency_key;

  IF FOUND THEN
    IF v_event.event_type IS DISTINCT FROM 'created'
       OR v_event.request_fingerprint IS DISTINCT FROM p_request_fingerprint THEN
      RAISE EXCEPTION USING
        ERRCODE = '23505',
        MESSAGE = 'work_item_idempotency_fingerprint_conflict';
    END IF;

    SELECT w.*
      INTO STRICT v_item
      FROM public.work_items w
     WHERE w.tenant_id = p_tenant_id
       AND w.id = v_event.work_item_id;

    RETURN jsonb_build_object(
      'outcome', 'replay',
      'work_item', to_jsonb(v_item),
      'event', to_jsonb(v_event)
    );
  END IF;

  -- A pre-existing item without its matching event cannot be safely replayed:
  -- the prior request fingerprint is unknowable, so fail closed.
  PERFORM 1
    FROM public.work_items w
   WHERE w.tenant_id = p_tenant_id
     AND w.idempotency_key = p_idempotency_key
   FOR UPDATE;
  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'work_item_idempotency_incomplete_conflict';
  END IF;

  v_actor_label := left(
    p_actor_type || ':' || COALESCE(NULLIF(btrim(p_actor_id), ''), 'system'),
    200
  );
  PERFORM set_config('app.actor_id', COALESCE(p_actor_id, ''), true);
  PERFORM set_config('app.actor_label', v_actor_label, true);

  INSERT INTO public.work_items (
    tenant_id,
    kind,
    department,
    title,
    summary,
    priority,
    authority_tier,
    assignee_type,
    assignee_id,
    source_type,
    source_id,
    entity_type,
    entity_id,
    idempotency_key,
    attention_queue_id,
    action_protocol,
    acceptance_criteria,
    sla_started_at,
    due_at,
    created_by_type,
    created_by_id
  ) VALUES (
    p_tenant_id,
    p_kind,
    p_department,
    p_title,
    p_summary,
    p_priority,
    p_required_authority_tier,
    p_assignee_type,
    p_assignee_id,
    p_source_type,
    p_source_id,
    p_entity_type,
    p_entity_id,
    p_idempotency_key,
    p_attention_queue_id,
    COALESCE(p_action_protocol, '{}'::jsonb),
    COALESCE(p_acceptance_criteria, '{}'::jsonb),
    COALESCE(p_sla_started_at, now()),
    p_due_at,
    p_actor_type,
    NULLIF(btrim(p_actor_id), '')
  )
  RETURNING * INTO v_item;

  INSERT INTO public.work_item_events (
    tenant_id,
    work_item_id,
    event_type,
    from_status,
    to_status,
    actor_type,
    actor_id,
    authority_tier,
    reason_code,
    idempotency_key,
    request_fingerprint,
    evidence
  ) VALUES (
    p_tenant_id,
    v_item.id,
    'created',
    NULL,
    'open',
    p_actor_type,
    NULLIF(btrim(p_actor_id), ''),
    p_actor_authority_tier,
    'work_item_created',
    p_idempotency_key,
    p_request_fingerprint,
    '{}'::jsonb
  )
  RETURNING * INTO v_event;

  RETURN jsonb_build_object(
    'outcome', 'created',
    'work_item', to_jsonb(v_item),
    'event', to_jsonb(v_event)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.work_item_transition_rpc(
  p_tenant_id uuid,
  p_work_item_id uuid,
  p_expected_revision integer,
  p_to_status text,
  p_idempotency_key text,
  p_request_fingerprint text,
  p_actor_type text,
  p_actor_id text,
  p_actor_authority_tier text,
  p_reason_code text DEFAULT NULL,
  p_assignee_type text DEFAULT NULL,
  p_assignee_id text DEFAULT NULL,
  p_verification_state text DEFAULT NULL,
  p_verification_evidence jsonb DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_claims text;
  v_calling_role text;
  v_event public.work_item_events%ROWTYPE;
  v_item public.work_items%ROWTYPE;
  v_from_status text;
  v_event_type text;
  v_actor_label text;
  v_actor_rank integer;
  v_required_rank integer;
  v_verification_state text;
  v_evidence jsonb;
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
      MESSAGE = 'work_item_rpc_requires_service_role';
  END IF;

  IF p_tenant_id IS NULL OR p_work_item_id IS NULL THEN
    RAISE EXCEPTION 'tenant_and_work_item_required';
  END IF;
  IF p_expected_revision IS NULL OR p_expected_revision < 1 THEN
    RAISE EXCEPTION 'expected_revision_must_be_positive';
  END IF;
  IF p_actor_type IS NULL
     OR p_actor_type NOT IN ('human', 'agent', 'service', 'system') THEN
    RAISE EXCEPTION 'invalid_actor_type';
  END IF;
  IF p_actor_authority_tier IS NULL
     OR p_actor_authority_tier NOT IN (
       'system', 'department_head', 'chief_of_staff', 'owner'
     ) THEN
    RAISE EXCEPTION 'invalid_actor_authority_tier';
  END IF;
  IF p_actor_type <> 'system' AND NULLIF(btrim(p_actor_id), '') IS NULL THEN
    RAISE EXCEPTION 'actor_id_required';
  END IF;
  IF p_actor_type = 'agent' AND p_actor_authority_tier = 'owner' THEN
    RAISE EXCEPTION 'agent_owner_authority_forbidden';
  END IF;
  IF p_actor_type IN ('service', 'system')
     AND p_actor_authority_tier <> 'system' THEN
    RAISE EXCEPTION 'service_or_system_authority_must_be_system';
  END IF;
  IF p_request_fingerprint IS NULL
     OR char_length(p_request_fingerprint) NOT BETWEEN 16 AND 128 THEN
    RAISE EXCEPTION 'invalid_request_fingerprint';
  END IF;
  IF p_idempotency_key IS NULL
     OR char_length(p_idempotency_key) NOT BETWEEN 8 AND 200 THEN
    RAISE EXCEPTION 'invalid_idempotency_key';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_tenant_id::text || ':' || p_idempotency_key, 0)
  );

  -- Replay is checked before revision: a client retry after a committed but
  -- lost response must receive the original result even if the item advanced.
  SELECT e.*
    INTO v_event
    FROM public.work_item_events e
   WHERE e.tenant_id = p_tenant_id
     AND e.idempotency_key = p_idempotency_key;

  IF FOUND THEN
    IF v_event.event_type = 'created'
       OR v_event.work_item_id IS DISTINCT FROM p_work_item_id
       OR v_event.to_status IS DISTINCT FROM p_to_status
       OR v_event.request_fingerprint IS DISTINCT FROM p_request_fingerprint THEN
      RAISE EXCEPTION USING
        ERRCODE = '23505',
        MESSAGE = 'work_item_idempotency_fingerprint_conflict';
    END IF;

    SELECT w.*
      INTO STRICT v_item
      FROM public.work_items w
     WHERE w.tenant_id = p_tenant_id
       AND w.id = p_work_item_id;

    RETURN jsonb_build_object(
      'outcome', 'replay',
      'work_item', to_jsonb(v_item),
      'event', to_jsonb(v_event)
    );
  END IF;

  -- Tenant predicate and row lock are part of the same lookup. A caller cannot
  -- transition an item under a different tenant binding.
  SELECT w.*
    INTO v_item
    FROM public.work_items w
   WHERE w.tenant_id = p_tenant_id
     AND w.id = p_work_item_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'work_item_not_found_for_tenant';
  END IF;

  IF v_item.revision IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'work_item_revision_conflict',
      DETAIL = format(
        'expected_revision=%s current_revision=%s',
        p_expected_revision,
        v_item.revision
      );
  END IF;

  v_actor_rank := CASE p_actor_authority_tier
    WHEN 'system' THEN 0
    WHEN 'department_head' THEN 1
    WHEN 'chief_of_staff' THEN 2
    WHEN 'owner' THEN 3
  END;
  v_required_rank := CASE v_item.authority_tier
    WHEN 'system' THEN 0
    WHEN 'department_head' THEN 1
    WHEN 'chief_of_staff' THEN 2
    WHEN 'owner' THEN 3
  END;
  IF v_actor_rank < v_required_rank THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'work_item_insufficient_authority_tier';
  END IF;

  v_from_status := v_item.status;
  IF NOT (
    (v_from_status = 'open'
      AND p_to_status IN ('claimed', 'in_progress', 'dismissed', 'cancelled'))
    OR (v_from_status = 'claimed'
      AND p_to_status IN ('open', 'in_progress', 'dismissed', 'cancelled'))
    OR (v_from_status = 'in_progress'
      AND p_to_status IN ('open', 'awaiting_verification', 'verified', 'cancelled'))
    OR (v_from_status = 'awaiting_verification'
      AND p_to_status IN ('in_progress', 'verified', 'cancelled'))
    OR (v_from_status IN ('verified', 'dismissed', 'cancelled')
      AND p_to_status = 'open')
  ) THEN
    RAISE EXCEPTION 'work_item_transition_not_allowed: % -> %',
      v_from_status, COALESCE(p_to_status, '<null>');
  END IF;

  IF p_to_status IN ('dismissed', 'cancelled')
     OR (
       v_from_status IN ('verified', 'dismissed', 'cancelled')
       AND p_to_status = 'open'
     ) THEN
    IF NULLIF(btrim(p_reason_code), '') IS NULL THEN
      RAISE EXCEPTION 'work_item_transition_reason_required';
    END IF;
  END IF;

  IF p_to_status = 'claimed' THEN
    IF p_assignee_type IS NULL
       OR p_assignee_type NOT IN ('human', 'agent', 'service')
       OR NULLIF(btrim(p_assignee_id), '') IS NULL THEN
      RAISE EXCEPTION 'work_item_claim_assignee_required';
    END IF;
  ELSIF p_assignee_type IS NOT NULL OR p_assignee_id IS NOT NULL THEN
    RAISE EXCEPTION 'assignee_fields_only_allowed_for_claim';
  END IF;

  v_evidence := COALESCE(p_verification_evidence, '{}'::jsonb);
  IF jsonb_typeof(v_evidence) <> 'object' THEN
    RAISE EXCEPTION 'verification_evidence_must_be_object';
  END IF;
  IF p_to_status = 'verified' THEN
    v_verification_state := COALESCE(
      NULLIF(p_verification_state, ''),
      v_item.verification_state
    );
    IF v_verification_state NOT IN ('passed', 'not_required') THEN
      RAISE EXCEPTION 'verified_work_requires_completed_verification';
    END IF;
    IF v_verification_state = 'passed' AND v_evidence = '{}'::jsonb THEN
      RAISE EXCEPTION 'passed_verification_requires_evidence';
    END IF;
  ELSE
    IF p_verification_state IS NOT NULL OR p_verification_evidence IS NOT NULL THEN
      RAISE EXCEPTION 'verification_fields_only_allowed_for_verified';
    END IF;
    v_verification_state := v_item.verification_state;
  END IF;

  v_actor_label := left(
    p_actor_type || ':' || COALESCE(NULLIF(btrim(p_actor_id), ''), 'system'),
    200
  );
  PERFORM set_config('app.actor_id', COALESCE(p_actor_id, ''), true);
  PERFORM set_config('app.actor_label', v_actor_label, true);

  UPDATE public.work_items
     SET status = p_to_status,
         reason_code = NULLIF(btrim(p_reason_code), ''),
         assignee_type = CASE
           WHEN p_to_status = 'claimed' THEN p_assignee_type
           ELSE assignee_type
         END,
         assignee_id = CASE
           WHEN p_to_status = 'claimed' THEN NULLIF(btrim(p_assignee_id), '')
           ELSE assignee_id
         END,
         claimed_at = CASE
           WHEN p_to_status = 'claimed' THEN now()
           ELSE claimed_at
         END,
         started_at = CASE
           WHEN p_to_status = 'in_progress' THEN COALESCE(started_at, now())
           ELSE started_at
         END,
         submitted_for_verification_at = CASE
           WHEN p_to_status = 'awaiting_verification' THEN now()
           WHEN p_to_status = 'open' THEN NULL
           ELSE submitted_for_verification_at
         END,
         verification_state = CASE
           WHEN p_to_status = 'awaiting_verification' THEN 'pending'
           WHEN p_to_status = 'in_progress'
             AND v_from_status = 'awaiting_verification' THEN 'failed'
           WHEN p_to_status = 'verified' THEN v_verification_state
           WHEN p_to_status = 'open' THEN 'pending'
           ELSE verification_state
         END,
         verification_evidence = CASE
           WHEN p_to_status = 'verified' THEN v_evidence
           WHEN p_to_status = 'open' THEN '{}'::jsonb
           ELSE verification_evidence
         END,
         verified_at = CASE
           WHEN p_to_status = 'verified' THEN now()
           WHEN p_to_status = 'open' THEN NULL
           ELSE verified_at
         END,
         resolved_at = CASE
           WHEN p_to_status IN ('verified', 'dismissed', 'cancelled') THEN now()
           WHEN p_to_status = 'open' THEN NULL
           ELSE resolved_at
         END
   WHERE id = p_work_item_id
     AND tenant_id = p_tenant_id
     AND revision = p_expected_revision
  RETURNING * INTO v_item;

  -- The row remains locked, but retain the revision predicate as a second
  -- defense against future refactors that might move or weaken the lock.
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'work_item_revision_conflict';
  END IF;

  v_event_type := CASE
    WHEN p_to_status = 'claimed' THEN 'claimed'
    WHEN p_to_status = 'in_progress'
      AND v_from_status = 'awaiting_verification' THEN 'verification_failed'
    WHEN p_to_status = 'in_progress' THEN 'started'
    WHEN p_to_status = 'awaiting_verification' THEN 'submitted_for_verification'
    WHEN p_to_status = 'verified' THEN 'verified'
    WHEN p_to_status = 'dismissed' THEN 'dismissed'
    WHEN p_to_status = 'cancelled' THEN 'cancelled'
    WHEN p_to_status = 'open'
      AND v_from_status IN ('verified', 'dismissed', 'cancelled') THEN 'reopened'
    WHEN p_to_status = 'open' THEN 'released'
    ELSE 'state_changed'
  END;

  INSERT INTO public.work_item_events (
    tenant_id,
    work_item_id,
    event_type,
    from_status,
    to_status,
    actor_type,
    actor_id,
    authority_tier,
    reason_code,
    idempotency_key,
    request_fingerprint,
    evidence
  ) VALUES (
    p_tenant_id,
    p_work_item_id,
    v_event_type,
    v_from_status,
    p_to_status,
    p_actor_type,
    NULLIF(btrim(p_actor_id), ''),
    p_actor_authority_tier,
    NULLIF(btrim(p_reason_code), ''),
    p_idempotency_key,
    p_request_fingerprint,
    CASE WHEN p_to_status = 'verified' THEN v_evidence ELSE '{}'::jsonb END
  )
  RETURNING * INTO v_event;

  RETURN jsonb_build_object(
    'outcome', 'transitioned',
    'work_item', to_jsonb(v_item),
    'event', to_jsonb(v_event)
  );
END;
$$;

-- PostgreSQL grants new functions to PUBLIC by default. These RPCs are an
-- internal command surface: the database grant and the in-function role check
-- both require service_role.
REVOKE EXECUTE ON FUNCTION public.work_item_create_rpc(
  uuid, text, text, text, text, text, text, text, text, text, text,
  text, text, text, text, text, text, text, uuid, jsonb, jsonb,
  timestamptz, timestamptz
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.work_item_create_rpc(
  uuid, text, text, text, text, text, text, text, text, text, text,
  text, text, text, text, text, text, text, uuid, jsonb, jsonb,
  timestamptz, timestamptz
) TO service_role;

REVOKE EXECUTE ON FUNCTION public.work_item_transition_rpc(
  uuid, uuid, integer, text, text, text, text, text, text,
  text, text, text, text, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.work_item_transition_rpc(
  uuid, uuid, integer, text, text, text, text, text, text,
  text, text, text, text, jsonb
) TO service_role;

