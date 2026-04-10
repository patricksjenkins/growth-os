-- Growth OS: Row-Level Security policies for tenant isolation

-- Helper: get current tenant from session
-- (set by API middleware via set_tenant_context RPC)

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

-- Tenant isolation policies (anon/authenticated users)
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

-- Service role bypass (worker + admin use service key which bypasses RLS by default in Supabase)
-- No explicit policy needed — service_role bypasses RLS automatically

-- Platform tables: tenant_config, tenant_modules, tenant_integrations
-- These use tenant_id but are accessed via service key from worker
-- For API access, restrict to own tenant
ALTER TABLE tenant_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_modules ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_integrations ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_iso_config ON tenant_config FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_iso_modules ON tenant_modules FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_iso_integrations ON tenant_integrations FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
