-- 045_email_connections.sql
-- OAuth token store for connected inboxes (Gmail/Outlook). The table was
-- referenced by core/email-agent.js but never migrated. The drip-campaign
-- Gmail reply sync (FGA's own patrick@firstgenautomate.com inbox) is the
-- first real consumer.

CREATE TABLE IF NOT EXISTS email_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider TEXT NOT NULL, -- 'gmail' | 'outlook'
  email_address TEXT,
  access_token TEXT,
  refresh_token TEXT,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider)
);

ALTER TABLE email_connections ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'email_connections' AND policyname = 'tenant_iso_email_connections'
  ) THEN
    CREATE POLICY tenant_iso_email_connections ON email_connections
      FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
  END IF;
END $$;
