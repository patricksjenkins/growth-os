-- Roll back the shadow-rearm command surface.
-- Engage cos_kill_switch_rpc before applying this rollback if shadow control
-- must also be contained; this file does not rewrite the existing control row.

BEGIN;

DROP FUNCTION IF EXISTS public.cos_shadow_activate_rpc(
  uuid, uuid, bigint, jsonb
);

CREATE OR REPLACE FUNCTION public.cos_control_guard()
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

COMMIT;
