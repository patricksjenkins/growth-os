-- Migration 014: scheduled_emails
--
-- Queue of future-dated transactional emails. Used by the onboarding
-- workflow (Day 21 / Day 37 / Day 67 check-ins) and any future use case
-- that needs to schedule a templated email for later send.
--
-- A worker agent (scheduled-email-dispatch) polls this table every ~15
-- minutes, picks up rows where send_at <= NOW() and status = 'pending',
-- sends them via the standard email integration, then marks them sent.

CREATE TABLE IF NOT EXISTS scheduled_emails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  to_email TEXT NOT NULL,
  template_name TEXT NOT NULL,
  template_vars JSONB DEFAULT '{}',
  subject TEXT,                    -- optional subject override
  send_at TIMESTAMPTZ NOT NULL,
  status TEXT DEFAULT 'pending',   -- pending | sent | failed | cancelled
  sent_at TIMESTAMPTZ,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scheduled_emails_tenant ON scheduled_emails(tenant_id);
-- Partial index for the dispatcher's hot-path query
CREATE INDEX IF NOT EXISTS idx_scheduled_emails_due
  ON scheduled_emails(send_at)
  WHERE status = 'pending';

ALTER TABLE scheduled_emails ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_iso_scheduled_emails ON scheduled_emails FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
