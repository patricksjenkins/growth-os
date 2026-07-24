-- ============================================================================
-- Migration 077: Tenant-safe Calendly appointment projection (G06)
-- Date: 2026-07-24
--
-- Projects already-verified Calendly booking receipts into the canonical
-- appointment workflow. It sends nothing and is disabled by default.
--
-- ROLLBACK: db/rollbacks/077_calendly_appointment_projection_rollback.sql
-- ============================================================================

DROP TRIGGER IF EXISTS trg_appointment_events_immutable
  ON public.appointment_events;
CREATE TRIGGER trg_appointment_events_immutable
  BEFORE UPDATE OR DELETE ON public.appointment_events
  FOR EACH ROW EXECUTE FUNCTION public.autonomous_os_immutable_row();

GRANT SELECT ON
  public.scheduling_policies,
  public.appointment_workflows,
  public.appointment_events
TO service_role;
REVOKE INSERT, UPDATE, DELETE ON
  public.scheduling_policies,
  public.appointment_workflows,
  public.appointment_events
FROM service_role;

CREATE OR REPLACE FUNCTION public.appointment_provider_event_rpc(
  p_tenant_id uuid,
  p_provider text,
  p_provider_event_id text,
  p_event_type text,
  p_appointment_type text,
  p_lead_id uuid,
  p_scheduled_start timestamptz,
  p_scheduled_end timestamptz,
  p_idempotency_key text,
  p_request_fingerprint text,
  p_feature_gate_enabled boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_claims text;
  v_calling_role text;
  v_existing_event public.appointment_events%ROWTYPE;
  v_workflow public.appointment_workflows%ROWTYPE;
  v_event public.appointment_events%ROWTYPE;
  v_previous_status text;
  v_expected_event_type text;
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
      MESSAGE = 'appointment_projection_requires_service_role';
  END IF;
  IF p_feature_gate_enabled IS DISTINCT FROM true THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'scheduling_writes_disabled';
  END IF;
  IF p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'appointment_tenant_required';
  END IF;
  IF lower(btrim(COALESCE(p_provider, ''))) <> 'calendly' THEN
    RAISE EXCEPTION 'appointment_provider_not_supported';
  END IF;
  IF p_event_type NOT IN ('booked', 'cancelled') THEN
    RAISE EXCEPTION 'appointment_provider_event_not_supported';
  END IF;
  v_expected_event_type := CASE p_event_type
    WHEN 'booked' THEN 'provider_booked'
    ELSE 'provider_cancelled'
  END;
  IF btrim(COALESCE(p_provider_event_id, '')) !~
     '^https://api[.]calendly[.]com/scheduled_events/[A-Za-z0-9_-]{6,200}$' THEN
    RAISE EXCEPTION 'appointment_provider_event_id_invalid';
  END IF;
  IF char_length(btrim(COALESCE(p_appointment_type, ''))) NOT BETWEEN 2 AND 80 THEN
    RAISE EXCEPTION 'appointment_type_invalid';
  END IF;
  IF char_length(btrim(COALESCE(p_idempotency_key, ''))) NOT BETWEEN 8 AND 200 THEN
    RAISE EXCEPTION 'appointment_event_idempotency_invalid';
  END IF;
  IF p_request_fingerprint !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'appointment_event_fingerprint_invalid';
  END IF;
  IF p_event_type = 'booked' AND (
    p_scheduled_start IS NULL
    OR p_scheduled_end IS NULL
    OR p_scheduled_end <= p_scheduled_start
  ) THEN
    RAISE EXCEPTION 'appointment_scheduled_window_invalid';
  END IF;
  IF p_event_type = 'cancelled'
     AND (p_scheduled_start IS NOT NULL OR p_scheduled_end IS NOT NULL) THEN
    RAISE EXCEPTION 'appointment_cancellation_must_not_supply_window';
  END IF;
  v_evidence := jsonb_build_object(
    'provider', 'calendly',
    'provider_event_id', btrim(p_provider_event_id),
    'event_type', p_event_type,
    'appointment_type', btrim(p_appointment_type),
    'lead_id', p_lead_id,
    'scheduled_start', p_scheduled_start,
    'scheduled_end', p_scheduled_end,
    'request_fingerprint', p_request_fingerprint
  );

  IF p_lead_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.leads lead
     WHERE lead.id = p_lead_id
       AND lead.tenant_id = p_tenant_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'appointment_lead_not_found_for_tenant';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      p_tenant_id::text || ':calendly:' || btrim(p_provider_event_id),
      0
    )
  );

  SELECT event.*
    INTO v_existing_event
    FROM public.appointment_events event
   WHERE event.tenant_id = p_tenant_id
     AND event.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing_event.provider_event_id IS DISTINCT FROM btrim(p_provider_event_id)
       OR v_existing_event.event_type IS DISTINCT FROM v_expected_event_type
       OR v_existing_event.evidence IS DISTINCT FROM v_evidence THEN
      RAISE EXCEPTION USING
        ERRCODE = '23505',
        MESSAGE = 'appointment_event_idempotency_conflict';
    END IF;
    SELECT workflow.*
      INTO STRICT v_workflow
      FROM public.appointment_workflows workflow
     WHERE workflow.id = v_existing_event.appointment_id
       AND workflow.tenant_id = p_tenant_id;
    RETURN jsonb_build_object(
      'outcome', 'replay',
      'appointment', to_jsonb(v_workflow),
      'event', to_jsonb(v_existing_event)
    );
  END IF;

  SELECT workflow.*
    INTO v_workflow
    FROM public.appointment_workflows workflow
   WHERE workflow.tenant_id = p_tenant_id
     AND workflow.provider = 'calendly'
     AND workflow.provider_event_id = btrim(p_provider_event_id)
   FOR UPDATE;

  IF p_event_type = 'booked' THEN
    IF FOUND THEN
      IF v_workflow.appointment_type IS DISTINCT FROM btrim(p_appointment_type)
         OR v_workflow.lead_id IS DISTINCT FROM p_lead_id
         OR v_workflow.scheduled_start IS DISTINCT FROM p_scheduled_start
         OR v_workflow.scheduled_end IS DISTINCT FROM p_scheduled_end
         OR v_workflow.status <> 'scheduled' THEN
        RAISE EXCEPTION USING
          ERRCODE = '23505',
          MESSAGE = 'appointment_provider_event_conflict';
      END IF;
      v_previous_status := v_workflow.status;
    ELSE
      INSERT INTO public.appointment_workflows (
        tenant_id,
        lead_id,
        appointment_type,
        status,
        provider,
        provider_event_id,
        scheduled_start,
        scheduled_end,
        idempotency_key
      ) VALUES (
        p_tenant_id,
        p_lead_id,
        btrim(p_appointment_type),
        'scheduled',
        'calendly',
        btrim(p_provider_event_id),
        p_scheduled_start,
        p_scheduled_end,
        'provider:calendly:' || encode(
          digest(p_tenant_id::text || ':' || btrim(p_provider_event_id), 'sha256'),
          'hex'
        )
      )
      RETURNING * INTO v_workflow;
      v_previous_status := NULL;
    END IF;
  ELSE
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0002',
        MESSAGE = 'appointment_provider_event_not_found_for_tenant';
    END IF;
    IF v_workflow.status IN ('completed', 'no_show') THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'appointment_terminal_history_cannot_be_cancelled';
    END IF;
    v_previous_status := v_workflow.status;
    IF v_workflow.status <> 'cancelled' THEN
      UPDATE public.appointment_workflows
         SET status = 'cancelled',
             exception_reason = 'provider_cancelled',
             updated_at = now()
       WHERE id = v_workflow.id
         AND tenant_id = p_tenant_id
      RETURNING * INTO v_workflow;
    END IF;
  END IF;

  INSERT INTO public.appointment_events (
    tenant_id,
    appointment_id,
    event_type,
    previous_status,
    next_status,
    provider_event_id,
    actor_type,
    actor_id,
    evidence,
    idempotency_key
  ) VALUES (
    p_tenant_id,
    v_workflow.id,
    v_expected_event_type,
    v_previous_status,
    v_workflow.status,
    btrim(p_provider_event_id),
    'system',
    NULL,
    v_evidence,
    p_idempotency_key
  )
  RETURNING * INTO v_event;

  RETURN jsonb_build_object(
    'outcome', CASE
      WHEN p_event_type = 'booked' THEN 'scheduled'
      ELSE 'cancelled'
    END,
    'appointment', to_jsonb(v_workflow),
    'event', to_jsonb(v_event)
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.appointment_provider_event_rpc(
  uuid, text, text, text, text, uuid, timestamptz, timestamptz,
  text, text, boolean
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.appointment_provider_event_rpc(
  uuid, text, text, text, text, uuid, timestamptz, timestamptz,
  text, text, boolean
) TO service_role;
