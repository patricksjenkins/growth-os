-- ============================================================================
-- Growth OS — Complete Database Schema (Source of Truth)
-- ============================================================================
-- This file contains the FULL schema for a fresh Supabase project.
-- Run this in the Supabase SQL Editor to set up the entire database.
--
-- For incremental changes, use numbered migration files in db/migrations/
-- ============================================================================

-- ============================================================================
-- 1. PLATFORM TABLES (no tenant_id — these ARE the tenant system)
-- ============================================================================

CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  vertical TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  owner_email TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenant_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  email TEXT NOT NULL,
  full_name TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(tenant_id, user_id)
);

CREATE TABLE IF NOT EXISTS tenant_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  UNIQUE(tenant_id, key)
);

CREATE TABLE IF NOT EXISTS tenant_modules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  module TEXT NOT NULL,
  enabled BOOLEAN DEFAULT true,
  config JSONB DEFAULT '{}',
  UNIQUE(tenant_id, module)
);

CREATE TABLE IF NOT EXISTS tenant_integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  service TEXT NOT NULL,
  credentials JSONB NOT NULL DEFAULT '{}',
  config JSONB DEFAULT '{}',
  status TEXT DEFAULT 'active',
  UNIQUE(tenant_id, service)
);

CREATE TABLE IF NOT EXISTS system_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT UNIQUE NOT NULL,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================================
-- 2. BUSINESS TABLES (all have tenant_id + RLS)
-- ============================================================================

CREATE TABLE IF NOT EXISTS leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  company_name TEXT,
  service_type TEXT,
  lead_source TEXT,
  status TEXT DEFAULT 'new_lead',
  priority_tier TEXT,
  lead_score INTEGER,
  estimate_amount DECIMAL,
  final_revenue DECIMAL,
  address TEXT,
  city TEXT,
  notes TEXT,
  loss_reason TEXT,
  assigned_to UUID,
  date_of_inquiry TIMESTAMPTZ DEFAULT now(),
  date_of_estimate TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  title TEXT,
  company TEXT,
  contact_type TEXT DEFAULT 'customer',
  outreach_status TEXT,
  drip_stage INTEGER DEFAULT 0,
  last_contacted_at TIMESTAMPTZ,
  notes TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS content_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  content_type TEXT DEFAULT 'carousel',
  platform TEXT DEFAULT 'linkedin',
  status TEXT DEFAULT 'draft',
  headline TEXT,
  body TEXT,
  hashtags TEXT[],
  image_urls TEXT[],
  campaign_payload JSONB,
  format_template TEXT,
  topic TEXT,
  scheduled_for TIMESTAMPTZ,
  posted_at TIMESTAMPTZ,
  buffer_post_id TEXT,
  approved_by UUID,
  rejected_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS outreach_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  campaign_type TEXT DEFAULT 'drip_email',
  status TEXT DEFAULT 'active',
  current_step INTEGER DEFAULT 0,
  total_steps INTEGER,
  next_send_at TIMESTAMPTZ,
  last_sent_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  campaign_id UUID REFERENCES outreach_campaigns(id) ON DELETE SET NULL,
  channel TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'outbound',
  subject TEXT,
  body TEXT,
  status TEXT DEFAULT 'sent',
  reply_classification TEXT,
  external_id TEXT,
  sent_at TIMESTAMPTZ DEFAULT now(),
  opened_at TIMESTAMPTZ,
  clicked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  status TEXT DEFAULT 'scheduled',
  scheduled_date DATE,
  completed_date DATE,
  description TEXT,
  revenue DECIMAL,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS job_photos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  job_id UUID REFERENCES jobs(id) ON DELETE CASCADE,
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  photo_type TEXT DEFAULT 'before',
  storage_path TEXT,
  public_url TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS meetings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  external_id TEXT,
  scheduled_at TIMESTAMPTZ,
  duration_minutes INTEGER,
  meeting_type TEXT,
  status TEXT DEFAULT 'scheduled',
  briefing JSONB,
  outcome TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS finance_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entry_type TEXT NOT NULL,
  category TEXT,
  amount DECIMAL NOT NULL,
  description TEXT,
  date DATE NOT NULL,
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  recurring BOOLEAN DEFAULT false,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crew_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT,
  daily_rate DECIMAL,
  phone TEXT,
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS marketing_performance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel TEXT,
  date DATE,
  impressions INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  conversions INTEGER DEFAULT 0,
  spend DECIMAL DEFAULT 0,
  revenue DECIMAL DEFAULT 0,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================================
-- 3. SYSTEM TABLES (tenant_id required)
-- ============================================================================

CREATE TABLE IF NOT EXISTS agent_activity_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_name TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT DEFAULT 'success',
  records_affected INTEGER DEFAULT 0,
  duration_ms INTEGER,
  details JSONB DEFAULT '{}',
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_name TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  payload JSONB DEFAULT '{}',
  result JSONB,
  error TEXT,
  priority INTEGER DEFAULT 0,
  scheduled_for TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  action TEXT NOT NULL,
  result JSONB,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(tenant_id, key)
);

-- ============================================================================
-- 4. RPC FUNCTIONS
-- ============================================================================

-- Set tenant context for RLS (called by API middleware)
CREATE OR REPLACE FUNCTION set_tenant_context(tid UUID)
RETURNS void AS $$
BEGIN
  PERFORM set_config('app.tenant_id', tid::text, true);
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- 5. INDEXES
-- ============================================================================

-- Platform tables
CREATE INDEX IF NOT EXISTS idx_tenant_users_tenant ON tenant_users(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_users_user ON tenant_users(user_id);
CREATE INDEX IF NOT EXISTS idx_tenant_config_tenant ON tenant_config(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_modules_tenant ON tenant_modules(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_integrations_tenant ON tenant_integrations(tenant_id);

-- Business tables
CREATE INDEX IF NOT EXISTS idx_leads_tenant_status ON leads(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_leads_tenant_source ON leads(tenant_id, lead_source);
CREATE INDEX IF NOT EXISTS idx_leads_tenant_date ON leads(tenant_id, date_of_inquiry);
CREATE INDEX IF NOT EXISTS idx_contacts_tenant ON contacts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_contacts_tenant_type ON contacts(tenant_id, contact_type);
CREATE INDEX IF NOT EXISTS idx_contacts_lead ON contacts(lead_id);
CREATE INDEX IF NOT EXISTS idx_content_drafts_tenant_status ON content_drafts(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_outreach_campaigns_tenant ON outreach_campaigns(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_outreach_campaigns_next ON outreach_campaigns(status, next_send_at);
CREATE INDEX IF NOT EXISTS idx_messages_tenant ON messages(tenant_id);
CREATE INDEX IF NOT EXISTS idx_messages_contact ON messages(contact_id);
CREATE INDEX IF NOT EXISTS idx_messages_campaign ON messages(campaign_id);
CREATE INDEX IF NOT EXISTS idx_jobs_tenant ON jobs(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_job_photos_job ON job_photos(job_id);
CREATE INDEX IF NOT EXISTS idx_meetings_tenant ON meetings(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_meetings_contact ON meetings(contact_id);
CREATE INDEX IF NOT EXISTS idx_finance_entries_tenant ON finance_entries(tenant_id, date);
CREATE INDEX IF NOT EXISTS idx_crew_members_tenant ON crew_members(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_marketing_perf_tenant ON marketing_performance(tenant_id, date);

-- System tables
CREATE INDEX IF NOT EXISTS idx_agent_jobs_status ON agent_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_jobs_tenant ON agent_jobs(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_agent_jobs_scheduled ON agent_jobs(status, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_agent_activity_tenant ON agent_activity_log(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_activity_agent ON agent_activity_log(agent_name, created_at);
CREATE INDEX IF NOT EXISTS idx_idempotency_tenant_key ON idempotency_keys(tenant_id, key);
CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_keys(expires_at);

-- ============================================================================
-- 6. ROW-LEVEL SECURITY
-- ============================================================================

-- Enable RLS on all business tables
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE outreach_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE meetings ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE crew_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_performance ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_activity_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;

-- Enable RLS on tenant-scoped platform tables
ALTER TABLE tenant_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_modules ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_users ENABLE ROW LEVEL SECURITY;

-- Tenant isolation policies (authenticated users see only their tenant's data)
CREATE POLICY tenant_iso_leads ON leads FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_iso_contacts ON contacts FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_iso_content ON content_drafts FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_iso_outreach ON outreach_campaigns FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_iso_messages ON messages FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_iso_jobs ON jobs FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_iso_photos ON job_photos FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_iso_meetings ON meetings FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_iso_finance ON finance_entries FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_iso_crew ON crew_members FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_iso_marketing ON marketing_performance FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_iso_activity ON agent_activity_log FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_iso_agent_jobs ON agent_jobs FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_iso_idempotency ON idempotency_keys FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_iso_config ON tenant_config FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_iso_modules ON tenant_modules FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_iso_integrations ON tenant_integrations FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_iso_users ON tenant_users FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Note: service_role bypasses RLS automatically in Supabase — no explicit policy needed
