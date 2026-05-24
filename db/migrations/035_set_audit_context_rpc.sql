-- Migration 035 — V1 hardening pass (2026-05-24)
-- ---------------------------------------------------------------------------
-- Replace the raw-SQL `exec_sql('SELECT set_config(...)')` pattern used by
-- api/routes/finance.js#setAuditContext with a dedicated SECURITY DEFINER
-- function that takes parameterized inputs. The previous pattern interpolated
-- `req.user.id` straight into a SQL string before passing it to exec_sql —
-- a latent SQL-injection vector that only avoided exploitation because
-- Supabase auth happens to always produce UUID-shaped user IDs today.
--
-- This function only writes to two GUC variables consumed by the
-- finance_entries audit trigger; it cannot read or modify any data on
-- its own. Granted to authenticated users so the existing API route
-- (which runs as the service role anyway) can keep working without
-- needing to call exec_sql.

CREATE OR REPLACE FUNCTION public.set_audit_context(
  p_actor_id uuid,
  p_actor_label text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- Both vars are PG GUCs the audit trigger reads via current_setting().
  -- Empty string clears the var so the trigger records NULL.
  PERFORM set_config(
    'app.actor_id',
    COALESCE(p_actor_id::text, ''),
    false
  );
  PERFORM set_config(
    'app.actor_label',
    COALESCE(left(p_actor_label, 200), ''),
    false
  );
END;
$$;

COMMENT ON FUNCTION public.set_audit_context IS
  'Sets app.actor_id + app.actor_label GUCs for the finance_entries audit '
  'trigger. Replaces the previous exec_sql(...string interpolation...) '
  'pattern with parameter binding. See migration 035 + codebase-audit-v1.html.';

-- Revoke broad access; only service role + authenticated users that
-- already hit /api/finance/* need this.
REVOKE EXECUTE ON FUNCTION public.set_audit_context(uuid, text) FROM public;
REVOKE EXECUTE ON FUNCTION public.set_audit_context(uuid, text) FROM anon;
GRANT  EXECUTE ON FUNCTION public.set_audit_context(uuid, text) TO authenticated;
GRANT  EXECUTE ON FUNCTION public.set_audit_context(uuid, text) TO service_role;

-- ---------------------------------------------------------------------------
-- Atomic CPA token use-count increment (V1 hardening #16).
-- Replaces the racy SELECT-then-UPDATE pattern in api/routes/cpa-readonly.js
-- middleware. Only the service role hits this (CPA tokens are loaded by
-- the API server, never directly by anon clients), so no auth grants.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.increment_cpa_token_use(
  p_token_id uuid
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE public.cpa_api_tokens
     SET use_count    = COALESCE(use_count, 0) + 1,
         last_used_at = now()
   WHERE id = p_token_id;
$$;

REVOKE EXECUTE ON FUNCTION public.increment_cpa_token_use(uuid) FROM public;
REVOKE EXECUTE ON FUNCTION public.increment_cpa_token_use(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.increment_cpa_token_use(uuid) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.increment_cpa_token_use(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- Messages idempotency (V1 hardening BUG #8).
-- Twilio retries inbound webhooks 11 times over 24h on any non-2xx. Without
-- a unique constraint on (tenant_id, external_id) the SMS handler in
-- api/webhooks/twilio.js double-inserts messages + double-enqueues
-- speed-to-lead / inbound-sms-responder jobs on every retry.
--
-- Partial index on rows where external_id is not null because outbound
-- messages we generate without a Twilio sid yet have NULL external_id.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS messages_tenant_external_id_uniq
  ON public.messages(tenant_id, external_id)
  WHERE external_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Atomic usage check + increment (V1 hardening BUG #13).
-- Replaces the racy checkUsageOrThrow + incrementUsage pair in
-- core/usage-caps.js. Two concurrent workers could both pass the SELECT
-- check before either UPDATE landed, allowing the tenant to overshoot
-- their cap. This RPC does the cap check and the increment in a single
-- statement so the race is impossible.
--
-- Returns:
--   allowed BOOLEAN — true if the increment was applied, false if cap hit
--   used    INTEGER — usage AFTER the (attempted) increment
--
-- The tenant_usage row is auto-created via INSERT ... ON CONFLICT if it
-- doesn't exist. Daily-counter self-heal (lead_capture_count_today) is
-- handled at the JS layer before calling this RPC.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.increment_usage_if_under_cap(
  p_tenant_id uuid,
  p_column text,
  p_amount integer,
  p_cap integer
) RETURNS TABLE(allowed boolean, used integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_used integer;
  v_sql text;
BEGIN
  -- Whitelist column names. plpgsql can't bind a column name as a
  -- parameter — but we MUST refuse arbitrary strings to avoid SQL
  -- injection via the function's caller.
  IF p_column NOT IN (
    'sms_count', 'email_send_count', 'chat_msg_count', 'image_gen_count',
    'twilio_voice_minutes_total', 'lead_capture_count_today',
    'claude_spend_cents', 'outreach_send_count', 'voice_minutes_used'
  ) THEN
    RAISE EXCEPTION 'invalid usage column: %', p_column;
  END IF;

  -- Ensure the row exists.
  INSERT INTO public.tenant_usage(tenant_id) VALUES (p_tenant_id)
    ON CONFLICT (tenant_id) DO NOTHING;

  -- Single atomic statement: take a row lock, check the cap, increment.
  v_sql := format(
    'UPDATE public.tenant_usage '
    'SET %I = COALESCE(%I, 0) + $1 '
    'WHERE tenant_id = $2 AND COALESCE(%I, 0) + $1 <= $3 '
    'RETURNING %I',
    p_column, p_column, p_column, p_column
  );
  EXECUTE v_sql INTO v_used USING p_amount, p_tenant_id, p_cap;

  IF v_used IS NOT NULL THEN
    allowed := true;
    used := v_used;
  ELSE
    -- UPDATE didn't match — cap would have been exceeded. Return
    -- current usage so the caller can report it.
    EXECUTE format('SELECT COALESCE(%I, 0) FROM public.tenant_usage WHERE tenant_id = $1', p_column)
      INTO v_used USING p_tenant_id;
    allowed := false;
    used := COALESCE(v_used, 0);
  END IF;

  RETURN NEXT;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.increment_usage_if_under_cap(uuid, text, integer, integer) FROM public;
REVOKE EXECUTE ON FUNCTION public.increment_usage_if_under_cap(uuid, text, integer, integer) FROM anon;
REVOKE EXECUTE ON FUNCTION public.increment_usage_if_under_cap(uuid, text, integer, integer) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.increment_usage_if_under_cap(uuid, text, integer, integer) TO service_role;
