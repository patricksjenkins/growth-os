-- ============================================================================
-- Migration 074: Transactional incident recovery reconciliation (G04)
-- Date: 2026-07-24
--
-- Additive foundation that binds a tenant-scoped Operations Guardian incident
-- to one canonical work item. A disabled-by-default, service-role-only RPC can
-- then record proven recovery, verify the work item, and resolve the legacy
-- attention_queue row in one transaction. Attention and incident history are
-- retained; no source row is deleted.
--
-- ROLLBACK: db/rollbacks/074_incident_recovery_reconciliation_rollback.sql
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.incident_work_item_links (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  incident_id              uuid NOT NULL REFERENCES public.ops_incidents(id) ON DELETE RESTRICT,
  work_item_id             uuid NOT NULL,
  attention_queue_id       uuid REFERENCES public.attention_queue(id) ON DELETE RESTRICT,
  linked_by_type           text NOT NULL
                             CHECK (linked_by_type IN ('human', 'agent', 'service', 'system')),
  linked_by_id             text,
  linked_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, incident_id),
  UNIQUE (tenant_id, work_item_id),
  FOREIGN KEY (work_item_id, tenant_id)
    REFERENCES public.work_items(id, tenant_id) ON DELETE RESTRICT,
  CHECK (
    linked_by_type = 'system'
    OR NULLIF(btrim(linked_by_id), '') IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS idx_incident_work_item_links_attention
  ON public.incident_work_item_links (tenant_id, attention_queue_id)
  WHERE attention_queue_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.incident_reconciliation_events (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  link_id                  uuid NOT NULL,
  incident_id              uuid NOT NULL REFERENCES public.ops_incidents(id) ON DELETE RESTRICT,
  work_item_id             uuid NOT NULL,
  attention_queue_id       uuid REFERENCES public.attention_queue(id) ON DELETE RESTRICT,
  event_type               text NOT NULL CHECK (event_type = 'incident_recovered'),
  incident_from_status     text NOT NULL,
  incident_to_status       text NOT NULL CHECK (incident_to_status = 'recovered'),
  work_item_from_status    text NOT NULL,
  work_item_to_status      text NOT NULL CHECK (work_item_to_status = 'verified'),
  attention_outcome        text NOT NULL
                             CHECK (attention_outcome IN (
                               'not_linked', 'already_resolved', 'superseded'
                             )),
  verification_method      text NOT NULL
                             CHECK (verification_method IN (
                               'dependency_probe', 'health_check', 'manual_review',
                               'output_observed', 'successful_run'
                             )),
  verification_reference   text NOT NULL
                             CHECK (
                               char_length(verification_reference) BETWEEN 3 AND 240
                               AND verification_reference
                                 ~ '^[a-z][a-z0-9_-]{1,39}:[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
                             ),
  observed_at              timestamptz NOT NULL,
  actor_type               text NOT NULL
                             CHECK (actor_type IN ('human', 'agent', 'service', 'system')),
  actor_id                 text,
  authority_tier           text NOT NULL
                             CHECK (authority_tier IN (
                               'system', 'department_head', 'chief_of_staff', 'owner'
                             )),
  idempotency_key          text NOT NULL
                             CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  request_fingerprint      text NOT NULL
                             CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  evidence                 jsonb NOT NULL,
  occurred_at              timestamptz NOT NULL DEFAULT now(),
  created_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, incident_id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (link_id, tenant_id)
    REFERENCES public.incident_work_item_links(id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (work_item_id, tenant_id)
    REFERENCES public.work_items(id, tenant_id) ON DELETE RESTRICT,
  CHECK (
    actor_type = 'system'
    OR NULLIF(btrim(actor_id), '') IS NOT NULL
  ),
  CHECK (jsonb_typeof(evidence) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_incident_reconciliation_events_tenant_time
  ON public.incident_reconciliation_events (tenant_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION public.incident_work_item_link_tenant_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.ops_incidents incident
     WHERE incident.id = NEW.incident_id
       AND incident.tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'incident_link_tenant_mismatch';
  END IF;

  IF NEW.attention_queue_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM public.attention_queue attention
     WHERE attention.id = NEW.attention_queue_id
       AND attention.tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'incident_attention_tenant_mismatch';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_incident_work_item_link_tenant_guard
  ON public.incident_work_item_links;
CREATE TRIGGER trg_incident_work_item_link_tenant_guard
  BEFORE INSERT OR UPDATE ON public.incident_work_item_links
  FOR EACH ROW EXECUTE FUNCTION public.incident_work_item_link_tenant_guard();
REVOKE EXECUTE ON FUNCTION public.incident_work_item_link_tenant_guard()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_incident_work_item_links_immutable
  ON public.incident_work_item_links;
CREATE TRIGGER trg_incident_work_item_links_immutable
  BEFORE UPDATE OR DELETE ON public.incident_work_item_links
  FOR EACH ROW EXECUTE FUNCTION public.autonomous_os_immutable_row();

DROP TRIGGER IF EXISTS trg_incident_reconciliation_events_immutable
  ON public.incident_reconciliation_events;
CREATE TRIGGER trg_incident_reconciliation_events_immutable
  BEFORE UPDATE OR DELETE ON public.incident_reconciliation_events
  FOR EACH ROW EXECUTE FUNCTION public.autonomous_os_immutable_row();

ALTER TABLE public.incident_work_item_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incident_reconciliation_events ENABLE ROW LEVEL SECURITY;

-- No authenticated policy is created: these platform-control records are
-- service-role-readable only. Mutation remains restricted to the RPC owner.
REVOKE ALL ON
  public.incident_work_item_links,
  public.incident_reconciliation_events
FROM PUBLIC, anon, authenticated;
GRANT SELECT ON
  public.incident_work_item_links,
  public.incident_reconciliation_events
TO service_role;
REVOKE INSERT, UPDATE, DELETE ON
  public.incident_work_item_links,
  public.incident_reconciliation_events
FROM service_role;

CREATE OR REPLACE FUNCTION public.incident_recovery_reconcile_rpc(
  p_tenant_id uuid,
  p_incident_id uuid,
  p_work_item_id uuid,
  p_expected_work_item_revision integer,
  p_idempotency_key text,
  p_request_fingerprint text,
  p_actor_type text,
  p_actor_id text,
  p_actor_authority_tier text,
  p_verification_method text,
  p_verification_reference text,
  p_observed_at timestamptz,
  p_feature_gate_enabled boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_claims text;
  v_calling_role text;
  v_actor_label text;
  v_actor_rank integer;
  v_required_rank integer;
  v_incident public.ops_incidents%ROWTYPE;
  v_work public.work_items%ROWTYPE;
  v_link public.incident_work_item_links%ROWTYPE;
  v_existing_link public.incident_work_item_links%ROWTYPE;
  v_event public.incident_reconciliation_events%ROWTYPE;
  v_attention_id uuid;
  v_attention_outcome text;
  v_attention_rows integer;
  v_incident_from_status text;
  v_work_from_status text;
  v_evidence jsonb;
  v_evidence_id uuid;
  v_authoritative_observed_at timestamptz;
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
      MESSAGE = 'incident_reconciliation_requires_service_role';
  END IF;
  IF p_feature_gate_enabled IS DISTINCT FROM true THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'incident_reconciliation_writes_disabled';
  END IF;

  IF p_tenant_id IS NULL OR p_incident_id IS NULL OR p_work_item_id IS NULL THEN
    RAISE EXCEPTION 'tenant_incident_and_work_item_required';
  END IF;
  IF p_expected_work_item_revision IS NULL OR p_expected_work_item_revision < 1 THEN
    RAISE EXCEPTION 'expected_work_item_revision_must_be_positive';
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
  IF p_idempotency_key IS NULL
     OR char_length(p_idempotency_key) NOT BETWEEN 8 AND 200 THEN
    RAISE EXCEPTION 'invalid_idempotency_key';
  END IF;
  IF p_request_fingerprint IS NULL
     OR p_request_fingerprint !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'invalid_request_fingerprint';
  END IF;
  IF p_verification_method IS NULL
     OR p_verification_method NOT IN (
       'dependency_probe', 'health_check', 'manual_review',
       'output_observed', 'successful_run'
     ) THEN
    RAISE EXCEPTION 'invalid_verification_method';
  END IF;
  IF p_verification_reference IS NULL
     OR btrim(p_verification_reference)
       !~ '^[a-z][a-z0-9_-]{1,39}:[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
     OR char_length(btrim(p_verification_reference)) > 240 THEN
    RAISE EXCEPTION 'invalid_verification_reference';
  END IF;
  IF p_observed_at IS NULL OR p_observed_at > now() THEN
    RAISE EXCEPTION 'invalid_recovery_observed_at';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      p_tenant_id::text || ':incident-recovery:' || p_idempotency_key,
      0
    )
  );

  SELECT event.*
    INTO v_event
    FROM public.incident_reconciliation_events event
   WHERE event.tenant_id = p_tenant_id
     AND event.idempotency_key = p_idempotency_key;

  IF FOUND THEN
    IF v_event.incident_id IS DISTINCT FROM p_incident_id
       OR v_event.work_item_id IS DISTINCT FROM p_work_item_id
       OR v_event.request_fingerprint IS DISTINCT FROM p_request_fingerprint THEN
      RAISE EXCEPTION USING
        ERRCODE = '23505',
        MESSAGE = 'incident_reconciliation_idempotency_conflict';
    END IF;

    SELECT incident.*
      INTO STRICT v_incident
      FROM public.ops_incidents incident
     WHERE incident.id = p_incident_id
       AND incident.tenant_id = p_tenant_id;
    SELECT work.*
      INTO STRICT v_work
      FROM public.work_items work
     WHERE work.id = p_work_item_id
       AND work.tenant_id = p_tenant_id;

    RETURN jsonb_build_object(
      'outcome', 'replay',
      'incident', to_jsonb(v_incident),
      'work_item', to_jsonb(v_work),
      'event', to_jsonb(v_event)
    );
  END IF;

  -- An event with this work-item idempotency key but no reconciliation event
  -- is an incomplete or conflicting prior command; never guess at a replay.
  IF EXISTS (
    SELECT 1
      FROM public.work_item_events work_event
     WHERE work_event.tenant_id = p_tenant_id
       AND work_event.idempotency_key = p_idempotency_key
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'incident_reconciliation_incomplete_conflict';
  END IF;

  SELECT incident.*
    INTO v_incident
    FROM public.ops_incidents incident
   WHERE incident.id = p_incident_id
     AND incident.tenant_id = p_tenant_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'incident_not_found_for_tenant';
  END IF;

  SELECT work.*
    INTO v_work
    FROM public.work_items work
   WHERE work.id = p_work_item_id
     AND work.tenant_id = p_tenant_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'work_item_not_found_for_tenant';
  END IF;

  IF v_work.revision IS DISTINCT FROM p_expected_work_item_revision THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'work_item_revision_conflict';
  END IF;
  IF v_incident.status NOT IN (
    'open', 'remediating', 'awaiting_approval', 'escalated'
  ) THEN
    RAISE EXCEPTION 'incident_not_recoverable_from_status: %', v_incident.status;
  END IF;
  IF p_observed_at < v_incident.detected_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'recovery_evidence_predates_incident';
  END IF;

  -- A syntactically valid citation is not evidence. Resolve the supported
  -- evidence type inside this tenant and derive its observation time from the
  -- authoritative row before any state changes occur.
  IF p_verification_method = 'successful_run' THEN
    IF v_incident.issue_type IN ('zero_output', 'healthy_no_output') THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'output_incident_requires_output_evidence';
    END IF;
    IF btrim(p_verification_reference) !~
       '^agent_job:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'successful_run_requires_agent_job_evidence';
    END IF;
    v_evidence_id := split_part(btrim(p_verification_reference), ':', 2)::uuid;
    SELECT COALESCE(job.completed_at, job.created_at)
      INTO v_authoritative_observed_at
      FROM public.agent_jobs job
     WHERE job.id = v_evidence_id
       AND job.tenant_id = p_tenant_id
       AND job.agent_name = v_incident.agent_name
       AND job.status IN ('completed', 'success')
       AND COALESCE(job.completed_at, job.created_at) >= v_incident.detected_at;
  ELSIF p_verification_method = 'output_observed' THEN
    IF v_incident.issue_type NOT IN ('zero_output', 'healthy_no_output')
       OR v_incident.agent_name <> 'prospecting' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'lead_output_evidence_not_valid_for_incident';
    END IF;
    IF btrim(p_verification_reference) !~
       '^lead:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'output_observed_requires_lead_evidence';
    END IF;
    v_evidence_id := split_part(btrim(p_verification_reference), ':', 2)::uuid;
    SELECT lead.created_at
      INTO v_authoritative_observed_at
      FROM public.leads lead
     WHERE lead.id = v_evidence_id
       AND lead.tenant_id = p_tenant_id
       AND lead.lead_source = 'prospecting_agent'
       AND lead.created_at >= v_incident.detected_at;
  ELSE
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'verification_method_not_authoritatively_supported';
  END IF;
  IF v_authoritative_observed_at IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'recovery_evidence_not_found_for_tenant';
  END IF;
  IF p_observed_at IS DISTINCT FROM v_authoritative_observed_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'recovery_observed_at_not_authoritative';
  END IF;

  IF v_work.status NOT IN (
    'open', 'claimed', 'in_progress', 'awaiting_verification'
  ) THEN
    RAISE EXCEPTION 'work_item_not_reconcilable_from_status: %', v_work.status;
  END IF;
  IF NOT (
    (
      v_work.source_type = 'ops_incident'
      AND v_work.source_id = p_incident_id::text
    )
    OR (
      v_work.entity_type = 'ops_incident'
      AND v_work.entity_id = p_incident_id::text
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'work_item_incident_source_mismatch';
  END IF;

  v_actor_rank := CASE p_actor_authority_tier
    WHEN 'system' THEN 0
    WHEN 'department_head' THEN 1
    WHEN 'chief_of_staff' THEN 2
    WHEN 'owner' THEN 3
  END;
  v_required_rank := CASE v_work.authority_tier
    WHEN 'system' THEN 0
    WHEN 'department_head' THEN 1
    WHEN 'chief_of_staff' THEN 2
    WHEN 'owner' THEN 3
  END;
  IF v_actor_rank < v_required_rank THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'incident_reconciliation_insufficient_authority';
  END IF;

  IF v_incident.attention_queue_id IS NOT NULL
     AND v_work.attention_queue_id IS NOT NULL
     AND v_incident.attention_queue_id IS DISTINCT FROM v_work.attention_queue_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'incident_attention_link_conflict';
  END IF;
  v_attention_id := COALESCE(
    v_incident.attention_queue_id,
    v_work.attention_queue_id
  );

  IF v_attention_id IS NOT NULL THEN
    PERFORM 1
      FROM public.attention_queue attention
     WHERE attention.id = v_attention_id
       AND attention.tenant_id = p_tenant_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'incident_attention_not_found_for_tenant';
    END IF;
  END IF;

  SELECT link.*
    INTO v_existing_link
    FROM public.incident_work_item_links link
   WHERE link.tenant_id = p_tenant_id
     AND (
       link.incident_id = p_incident_id
       OR link.work_item_id = p_work_item_id
     )
   FOR UPDATE;
  IF FOUND AND (
    v_existing_link.incident_id IS DISTINCT FROM p_incident_id
    OR v_existing_link.work_item_id IS DISTINCT FROM p_work_item_id
    OR v_existing_link.attention_queue_id IS DISTINCT FROM v_attention_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'incident_work_item_link_conflict';
  END IF;

  v_actor_label := left(
    p_actor_type || ':' || COALESCE(NULLIF(btrim(p_actor_id), ''), 'system'),
    200
  );
  PERFORM set_config('app.actor_id', COALESCE(p_actor_id, ''), true);
  PERFORM set_config('app.actor_label', v_actor_label, true);

  IF v_existing_link.id IS NULL THEN
    INSERT INTO public.incident_work_item_links (
      tenant_id,
      incident_id,
      work_item_id,
      attention_queue_id,
      linked_by_type,
      linked_by_id
    ) VALUES (
      p_tenant_id,
      p_incident_id,
      p_work_item_id,
      v_attention_id,
      p_actor_type,
      NULLIF(btrim(p_actor_id), '')
    )
    RETURNING * INTO v_link;
  ELSE
    v_link := v_existing_link;
  END IF;

  v_evidence := jsonb_build_object(
    'result', 'recovered',
    'verification_method', p_verification_method,
    'verification_reference', btrim(p_verification_reference),
    'observed_at', v_authoritative_observed_at
  );
  v_incident_from_status := v_incident.status;
  v_work_from_status := v_work.status;

  UPDATE public.work_items
     SET status = 'verified',
         attention_queue_id = COALESCE(attention_queue_id, v_attention_id),
         verification_state = 'passed',
         verification_evidence = v_evidence,
         reason_code = 'incident_recovered',
         submitted_for_verification_at =
           COALESCE(submitted_for_verification_at, now()),
         verified_at = now(),
         resolved_at = now()
   WHERE id = p_work_item_id
     AND tenant_id = p_tenant_id
     AND revision = p_expected_work_item_revision
  RETURNING * INTO v_work;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'work_item_revision_conflict';
  END IF;

  UPDATE public.ops_incidents
     SET status = 'recovered',
         verification_result = 'recovered',
         resolved_at = now(),
         updated_at = now()
   WHERE id = p_incident_id
     AND tenant_id = p_tenant_id
     AND status = v_incident_from_status
  RETURNING * INTO v_incident;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'incident_state_conflict';
  END IF;

  v_attention_outcome := 'not_linked';
  IF v_attention_id IS NOT NULL THEN
    UPDATE public.attention_queue
       SET resolved_at = now(),
           resolved_by_label = v_actor_label,
           resolution = 'superseded_by_canonical_incident_recovery',
           resolution_payload =
             COALESCE(resolution_payload, '{}'::jsonb)
             || jsonb_build_object(
               'incident_id', p_incident_id,
               'work_item_id', p_work_item_id,
               'reconciliation', 'incident_recovered'
             )
     WHERE id = v_attention_id
       AND tenant_id = p_tenant_id
       AND resolved_at IS NULL;
    GET DIAGNOSTICS v_attention_rows = ROW_COUNT;
    v_attention_outcome := CASE
      WHEN v_attention_rows = 1 THEN 'superseded'
      ELSE 'already_resolved'
    END;
  END IF;

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
    'incident_recovered',
    v_work_from_status,
    'verified',
    p_actor_type,
    NULLIF(btrim(p_actor_id), ''),
    p_actor_authority_tier,
    'incident_recovered',
    p_idempotency_key,
    p_request_fingerprint,
    v_evidence
  );

  INSERT INTO public.incident_reconciliation_events (
    tenant_id,
    link_id,
    incident_id,
    work_item_id,
    attention_queue_id,
    event_type,
    incident_from_status,
    incident_to_status,
    work_item_from_status,
    work_item_to_status,
    attention_outcome,
    verification_method,
    verification_reference,
    observed_at,
    actor_type,
    actor_id,
    authority_tier,
    idempotency_key,
    request_fingerprint,
    evidence
  ) VALUES (
    p_tenant_id,
    v_link.id,
    p_incident_id,
    p_work_item_id,
    v_attention_id,
    'incident_recovered',
    v_incident_from_status,
    'recovered',
    v_work_from_status,
    'verified',
    v_attention_outcome,
    p_verification_method,
    btrim(p_verification_reference),
    v_authoritative_observed_at,
    p_actor_type,
    NULLIF(btrim(p_actor_id), ''),
    p_actor_authority_tier,
    p_idempotency_key,
    p_request_fingerprint,
    v_evidence
  )
  RETURNING * INTO v_event;

  RETURN jsonb_build_object(
    'outcome', 'reconciled',
    'incident', to_jsonb(v_incident),
    'work_item', to_jsonb(v_work),
    'attention_outcome', v_attention_outcome,
    'event', to_jsonb(v_event)
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.incident_recovery_reconcile_rpc(
  uuid, uuid, uuid, integer, text, text, text, text, text,
  text, text, timestamptz, boolean
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.incident_recovery_reconcile_rpc(
  uuid, uuid, uuid, integer, text, text, text, text, text,
  text, text, timestamptz, boolean
) TO service_role;
