-- Migration 019: usage-cap tracking columns + monthly reset support
--
-- Adds per-tenant monthly counters that the new core/usage-caps.js helper
-- reads + increments. Every expensive op (Claude call, email send, Twilio
-- voice minute, Gemini image, chat reply, lead capture, outreach send)
-- runs through checkUsageOrThrow() which compares the current month's
-- counter against the tenant's tier-default cap and throws if over.
--
-- All columns default to 0. They reset to 0 on the 1st of each month via
-- the new monthly-usage-reset cron (worker/scheduler/cron.js).
--
-- A separate counter for daily lead-capture protects against per-tenant
-- spam attacks that bypass the existing per-IP rate limiter.

-- Drop the legacy single-column add from migration 018 if it's the only
-- column; this migration is additive so we just ADD new ones.
ALTER TABLE IF EXISTS tenant_usage
  ADD COLUMN IF NOT EXISTS sms_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS email_send_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS chat_msg_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS image_gen_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS twilio_voice_minutes_total INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS outreach_send_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS claude_input_tokens BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS claude_output_tokens BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS claude_spend_cents INTEGER NOT NULL DEFAULT 0,
  -- Daily lead-capture counter (resets at midnight UTC, not monthly)
  ADD COLUMN IF NOT EXISTS lead_capture_count_today INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lead_capture_count_today_date DATE,
  -- Bookkeeping
  ADD COLUMN IF NOT EXISTS month_resets_at TIMESTAMPTZ;

-- Index by tenant for fast lookup (most queries are .eq('tenant_id', ...))
CREATE INDEX IF NOT EXISTS idx_tenant_usage_tenant ON tenant_usage(tenant_id);

-- Seed a row for every existing tenant so the upsert pattern in usage-caps.js
-- doesn't race on cold start. Idempotent.
INSERT INTO tenant_usage (tenant_id)
SELECT id FROM tenants
ON CONFLICT (tenant_id) DO NOTHING;

-- ─── Optional helper: increment_usage(tenant, column, amount) ───
-- Atomic increment via SQL function. The agents currently fall back to
-- read-modify-write if this RPC is missing (so deploy order doesn't matter),
-- but the RPC saves a round-trip + avoids races under high concurrency.
CREATE OR REPLACE FUNCTION increment_usage(
  p_tenant_id UUID,
  p_column TEXT,
  p_amount BIGINT
) RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  new_value BIGINT;
  query TEXT;
BEGIN
  -- Whitelist allowed columns to prevent SQL injection
  IF p_column NOT IN (
    'sms_count', 'email_send_count', 'chat_msg_count', 'image_gen_count',
    'twilio_voice_minutes_total', 'outreach_send_count', 'voice_minutes_used',
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

-- Voice minutes RPC referenced in worker/agents/voice-receptionist.js
CREATE OR REPLACE FUNCTION increment_voice_minutes(
  p_tenant_id UUID,
  p_minutes INTEGER
) RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN increment_usage(p_tenant_id, 'voice_minutes_used', p_minutes);
END;
$$;
