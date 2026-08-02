-- 101: take Twilio's name off the schema.
--
-- Telnyx is the carrier and has been since the 2026-06 cutover. The Twilio
-- webhook route is retired (migration 100 + webhook-route-policy), so nothing
-- Twilio-shaped reaches this database any more. What was left was its name, on
-- two columns that every voice call and every usage check still writes to:
--
--   voice_calls.twilio_call_sid          -> call_sid
--   tenant_usage.twilio_voice_minutes_total -> voice_minutes_total
--
-- Both are live. voice_calls.call_sid is the UNIQUE idempotency key for the
-- Vapi webhook (which is at-least-once), and voice_minutes_total is read by
-- the usage-cap RPC on every call. Renaming rather than adding-and-migrating
-- keeps that atomicity intact: ALTER ... RENAME COLUMN carries the data, the
-- NOT NULL, the UNIQUE constraint and its index with it, in one statement.
--
-- The RPC below has to be replaced in the same migration. Its column
-- allow-list is a SQL-injection guard — plpgsql cannot bind a column name as a
-- parameter, so the function refuses any name not on the list. Rename the
-- column without updating the list and every voice-minute increment starts
-- raising 'invalid usage column'. Rename them together and neither is ever
-- wrong.
--
-- `voice_minutes_used` is a DIFFERENT existing column and is left alone.

ALTER TABLE public.voice_calls  RENAME COLUMN twilio_call_sid           TO call_sid;
ALTER TABLE public.tenant_usage RENAME COLUMN twilio_voice_minutes_total TO voice_minutes_total;

COMMENT ON COLUMN public.voice_calls.call_sid IS
  'Carrier call identifier (Telnyx call control id, or Vapi call id). UNIQUE — the voice webhook is at-least-once, so this is what stops a retry inserting twice.';
COMMENT ON COLUMN public.tenant_usage.voice_minutes_total IS
  'Total carrier voice minutes this month, rounded up per call the way the carrier bills.';

-- TWO functions carry a column allow-list, not one. `increment_usage` is the
-- plain counter and `increment_usage_if_under_cap` is the capped one; both
-- guard against injection the same way and both list the column by name.
-- Updating only the obvious one leaves the other raising
-- 'increment_usage: column voice_minutes_total not allowed' on every call.

CREATE OR REPLACE FUNCTION public.increment_usage(
  p_tenant_id uuid,
  p_column    text,
  p_amount    bigint
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  new_value BIGINT;
  query TEXT;
BEGIN
  IF p_column NOT IN (
    'sms_count', 'email_send_count', 'chat_msg_count', 'image_gen_count',
    'voice_minutes_total', 'outreach_send_count', 'voice_minutes_used',
    'claude_input_tokens', 'claude_output_tokens', 'claude_spend_cents',
    'lead_capture_count_today'
  ) THEN
    RAISE EXCEPTION 'increment_usage: column % not allowed', p_column;
  END IF;

  query := format(
    'INSERT INTO tenant_usage (tenant_id, %I) VALUES ($1, $2) ' ||
    'ON CONFLICT (tenant_id) DO UPDATE SET %I = tenant_usage.%I + $2 ' ||
    'RETURNING %I',
    p_column, p_column, p_column, p_column
  );
  EXECUTE query INTO new_value USING p_tenant_id, p_amount;
  RETURN new_value;
END;
$$;

-- Replace the usage-cap RPC with the renamed column on its allow-list.
-- Body is otherwise identical to migration 035.
CREATE OR REPLACE FUNCTION public.increment_usage_if_under_cap(
  p_tenant_id uuid,
  p_column    text,
  p_amount    integer,
  p_cap       integer
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
    'voice_minutes_total', 'lead_capture_count_today',
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

  IF v_used IS NULL THEN
    EXECUTE format('SELECT COALESCE(%I, 0) FROM public.tenant_usage WHERE tenant_id = $1', p_column)
      INTO v_used USING p_tenant_id;
    RETURN QUERY SELECT false, v_used;
  ELSE
    RETURN QUERY SELECT true, v_used;
  END IF;
END;
$$;
