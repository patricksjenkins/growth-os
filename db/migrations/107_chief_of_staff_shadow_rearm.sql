-- 107 — Owner-authenticated Chief of Staff shadow rearm
--
-- The original control correctly made an engaged kill switch one-way, but the
-- production seed was created disabled + engaged. That made first activation
-- impossible even in read-only shadow mode. This migration adds one narrow
-- exception: a service-mediated, tenant-owner-authenticated RPC may rearm the
-- control only as shadow/read-only with every production authority false.
-- Every direct update and every attempt to grant authority remains blocked.

BEGIN;

CREATE OR REPLACE FUNCTION public.cos_control_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_shadow_rearm boolean := COALESCE(
    current_setting('app.cos_shadow_rearm', true), ''
  ) = 'true';
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.kill_switch_engaged = true
     AND NEW.kill_switch_engaged = false
     AND NOT (
       v_shadow_rearm
       AND NEW.enabled = true
       AND NEW.execution_mode = 'shadow'
       AND NEW.read_only = true
       AND NEW.production_write_enabled = false
       AND NEW.provider_dispatch_enabled = false
       AND NEW.customer_communication_enabled = false
       AND NEW.financial_action_enabled = false
       AND NEW.activated_by IS NOT NULL
       AND NEW.activation_evidence <> '{}'::jsonb
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'cos_kill_switch_is_one_way';
  END IF;
  IF NEW.read_only IS DISTINCT FROM true
     OR NEW.production_write_enabled IS DISTINCT FROM false
     OR NEW.provider_dispatch_enabled IS DISTINCT FROM false
     OR NEW.customer_communication_enabled IS DISTINCT FROM false
     OR NEW.financial_action_enabled IS DISTINCT FROM false THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'cos_production_authority_forbidden';
  END IF;
  IF NEW.enabled = true AND (
    NEW.execution_mode NOT IN ('shadow', 'supervised')
    OR NEW.kill_switch_engaged IS DISTINCT FROM false
    OR NEW.activated_by IS NULL
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
      MESSAGE = 'cos_activation_invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.cos_shadow_activate_rpc(
  p_tenant_id uuid,
  p_actor_id uuid,
  p_expected_revision bigint,
  p_evidence jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_claims text;
  v_role text;
  v_control public.cos_supervision_controls%ROWTYPE;
BEGIN
  v_claims := NULLIF(current_setting('request.jwt.claims', true), '');
  v_role := COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    CASE WHEN v_claims IS NOT NULL THEN v_claims::jsonb ->> 'role' END,
    session_user::text
  );
  IF v_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'cos_requires_service_role';
  END IF;
  IF p_tenant_id IS NULL OR p_actor_id IS NULL
     OR p_expected_revision IS NULL OR p_expected_revision < 0
     OR jsonb_typeof(COALESCE(p_evidence, 'null'::jsonb)) <> 'object'
     OR p_evidence = '{}'::jsonb
     OR char_length(btrim(COALESCE(p_evidence->>'source_type', '')))
        NOT BETWEEN 3 AND 80
     OR char_length(btrim(COALESCE(p_evidence->>'source_id', '')))
        NOT BETWEEN 3 AND 240
     OR NULLIF(btrim(COALESCE(p_evidence->>'observed_at', '')), '') IS NULL THEN
    RAISE EXCEPTION 'cos_shadow_activation_invalid';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.tenant_users tenant_user
     WHERE tenant_user.tenant_id = p_tenant_id
       AND tenant_user.user_id = p_actor_id
       AND tenant_user.role IN (
         'owner', 'platform_owner', 'founder', 'admin',
         'client_owner', 'tenant_owner'
       )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'cos_owner_required';
  END IF;

  SELECT control.* INTO v_control
    FROM public.cos_supervision_controls control
   WHERE control.tenant_id = p_tenant_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'cos_control_not_found'; END IF;
  IF v_control.enabled = true
     AND v_control.execution_mode = 'shadow'
     AND v_control.read_only = true
     AND v_control.kill_switch_engaged = false
     AND v_control.production_write_enabled = false
     AND v_control.provider_dispatch_enabled = false
     AND v_control.customer_communication_enabled = false
     AND v_control.financial_action_enabled = false THEN
    RETURN jsonb_build_object(
      'outcome', 'already_active', 'execution_mode', 'shadow',
      'read_only', true, 'revision', v_control.revision
    );
  END IF;
  IF v_control.revision <> p_expected_revision
     OR v_control.enabled <> false
     OR v_control.execution_mode <> 'disabled'
     OR v_control.kill_switch_engaged <> true
     OR v_control.read_only <> true
     OR v_control.production_write_enabled <> false
     OR v_control.provider_dispatch_enabled <> false
     OR v_control.customer_communication_enabled <> false
     OR v_control.financial_action_enabled <> false THEN
    RAISE EXCEPTION 'cos_shadow_activation_gate_failed';
  END IF;

  PERFORM set_config('app.cos_shadow_rearm', 'true', true);
  UPDATE public.cos_supervision_controls
     SET enabled = true,
         execution_mode = 'shadow',
         kill_switch_engaged = false,
         activated_by = p_actor_id,
         activation_evidence = p_evidence,
         revision = revision + 1,
         updated_at = now()
   WHERE tenant_id = p_tenant_id
   RETURNING * INTO v_control;

  RETURN jsonb_build_object(
    'outcome', 'activated', 'execution_mode', v_control.execution_mode,
    'read_only', v_control.read_only, 'revision', v_control.revision,
    'production_authority', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.cos_shadow_activate_rpc(
  uuid, uuid, bigint, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cos_shadow_activate_rpc(
  uuid, uuid, bigint, jsonb
) TO service_role;

COMMIT;
