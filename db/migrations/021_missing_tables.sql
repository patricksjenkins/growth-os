-- ---------------------------------------------------------------------------
-- 021_missing_tables.sql — Creates tenant_usage and notifications tables
-- ---------------------------------------------------------------------------
-- These two tables were referenced by agents and routes but never had a
-- CREATE TABLE migration. Migrations 018 + 019 used ALTER TABLE IF EXISTS
-- which silently no-oped because the table didn't exist.
--
-- After this migration, re-run 019_usage_caps.sql to add the columns and
-- seed rows.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. tenant_usage — per-tenant monthly usage counters
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS tenant_usage (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  -- Voice minutes (from 018)
  voice_minutes_used INTEGER NOT NULL DEFAULT 0,
  -- Monthly counters (from 019 — duplicated here so a single migration works)
  sms_count INTEGER NOT NULL DEFAULT 0,
  email_send_count INTEGER NOT NULL DEFAULT 0,
  chat_msg_count INTEGER NOT NULL DEFAULT 0,
  image_gen_count INTEGER NOT NULL DEFAULT 0,
  twilio_voice_minutes_total INTEGER NOT NULL DEFAULT 0,
  outreach_send_count INTEGER NOT NULL DEFAULT 0,
  claude_input_tokens BIGINT NOT NULL DEFAULT 0,
  claude_output_tokens BIGINT NOT NULL DEFAULT 0,
  claude_spend_cents INTEGER NOT NULL DEFAULT 0,
  lead_capture_count_today INTEGER NOT NULL DEFAULT 0,
  lead_capture_count_today_date DATE,
  month_resets_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tenant_usage_tenant ON tenant_usage(tenant_id);

-- Seed a row for every existing tenant
INSERT INTO tenant_usage (tenant_id)
SELECT id FROM tenants
ON CONFLICT (tenant_id) DO NOTHING;

-- RLS
ALTER TABLE tenant_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_iso_tenant_usage ON tenant_usage FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Re-create the increment helpers from 019 (safe to run even if 019 was applied)
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

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. notifications — queued alerts for push, email, SMS delivery
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Delivery channel: push | email | sms
  channel TEXT NOT NULL DEFAULT 'email',
  -- Who gets it (null = tenant owner)
  recipient_email TEXT,
  recipient_phone TEXT,
  -- Content
  title TEXT,
  message TEXT,
  -- Priority: normal | high | urgent
  priority TEXT NOT NULL DEFAULT 'normal',
  -- Lifecycle: pending → sent | failed
  status TEXT NOT NULL DEFAULT 'pending',
  -- Category for grouping/dedup: new_lead, content_ready, payment_failed, etc.
  category TEXT,
  -- Reference to the entity that triggered this notification
  entity_type TEXT,
  entity_id UUID,
  -- Metadata (JSON) for deep-link info, extra context
  metadata JSONB DEFAULT '{}',
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_tenant_pending
  ON notifications(tenant_id, status, created_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_notifications_tenant_created
  ON notifications(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_category
  ON notifications(tenant_id, category);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_iso_notifications ON notifications FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
