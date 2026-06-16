-- 050_rls_drop_user_metadata_fallback.sql
-- Security hardening: migration 038 created tenant-isolation JWT policies that
-- read tenant_id from COALESCE(app_metadata, user_metadata). user_metadata is
-- editable by the end user themselves, so a malicious tenant user could rewrite
-- their own user_metadata.tenant_id and read another tenant's rows. Supabase's
-- security advisor flags this as rls_references_user_metadata (41 ERRORs).
--
-- Every auth user in this project already carries app_metadata.tenant_id (set in
-- core/welcome-wizard.js on create + patch), so dropping the user_metadata branch
-- changes no legitimate access. The Express API uses the service-role key (which
-- bypasses RLS entirely) for all data access; these policies are defense-in-depth
-- for any future direct-from-client Supabase reads.
--
-- Pattern: service_role bypass OR tenant_id = app_metadata.tenant_id (only).

DROP POLICY IF EXISTS tenant_iso_jwt_tenants ON tenants;
CREATE POLICY tenant_iso_jwt_tenants ON tenants FOR ALL USING (auth.role() = 'service_role' OR id = NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid);
DROP POLICY IF EXISTS tenant_iso_jwt_tenant_users ON tenant_users;
CREATE POLICY tenant_iso_jwt_tenant_users ON tenant_users FOR ALL USING (auth.role() = 'service_role' OR tenant_id = NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid);
DROP POLICY IF EXISTS tenant_iso_jwt_tenant_config ON tenant_config;
CREATE POLICY tenant_iso_jwt_tenant_config ON tenant_config FOR ALL USING (auth.role() = 'service_role' OR tenant_id = NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid);
DROP POLICY IF EXISTS tenant_iso_jwt_tenant_modules ON tenant_modules;
CREATE POLICY tenant_iso_jwt_tenant_modules ON tenant_modules FOR ALL USING (auth.role() = 'service_role' OR tenant_id = NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid);
DROP POLICY IF EXISTS tenant_iso_jwt_tenant_integrations ON tenant_integrations;
CREATE POLICY tenant_iso_jwt_tenant_integrations ON tenant_integrations FOR ALL USING (auth.role() = 'service_role' OR tenant_id = NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid);
DROP POLICY IF EXISTS tenant_iso_jwt_tenant_usage ON tenant_usage;
CREATE POLICY tenant_iso_jwt_tenant_usage ON tenant_usage FOR ALL USING (auth.role() = 'service_role' OR tenant_id = NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid);
DROP POLICY IF EXISTS tenant_iso_jwt_leads ON leads;
CREATE POLICY tenant_iso_jwt_leads ON leads FOR ALL USING (auth.role() = 'service_role' OR tenant_id = NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid);
DROP POLICY IF EXISTS tenant_iso_jwt_contacts ON contacts;
CREATE POLICY tenant_iso_jwt_contacts ON contacts FOR ALL USING (auth.role() = 'service_role' OR tenant_id = NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid);
DROP POLICY IF EXISTS tenant_iso_jwt_messages ON messages;
CREATE POLICY tenant_iso_jwt_messages ON messages FOR ALL USING (auth.role() = 'service_role' OR tenant_id = NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid);
DROP POLICY IF EXISTS tenant_iso_jwt_conversations ON conversations;
CREATE POLICY tenant_iso_jwt_conversations ON conversations FOR ALL USING (auth.role() = 'service_role' OR tenant_id = NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid);
DROP POLICY IF EXISTS tenant_iso_jwt_outreach_sequences ON outreach_sequences;
CREATE POLICY tenant_iso_jwt_outreach_sequences ON outreach_sequences FOR ALL USING (auth.role() = 'service_role' OR tenant_id = NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid);
DROP POLICY IF EXISTS tenant_iso_jwt_outreach_campaigns ON outreach_campaigns;
CREATE POLICY tenant_iso_jwt_outreach_campaigns ON outreach_campaigns FOR ALL USING (auth.role() = 'service_role' OR tenant_id = NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid);
DROP POLICY IF EXISTS tenant_iso_jwt_activity_log ON activity_log;
CREATE POLICY tenant_iso_jwt_activity_log ON activity_log FOR ALL USING (auth.role() = 'service_role' OR tenant_id = NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid);
DROP POLICY IF EXISTS tenant_iso_jwt_agent_activity_log ON agent_activity_log;
CREATE POLICY tenant_iso_jwt_agent_activity_log ON agent_activity_log FOR ALL USING (auth.role() = 'service_role' OR tenant_id = NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid);
DROP POLICY IF EXISTS tenant_iso_jwt_agent_jobs ON agent_jobs;
CREATE POLICY tenant_iso_jwt_agent_jobs ON agent_jobs FOR ALL USING (auth.role() = 'service_role' OR tenant_id = NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid);
DROP POLICY IF EXISTS tenant_iso_jwt_content_drafts ON content_drafts;
CREATE POLICY tenant_iso_jwt_content_drafts ON content_drafts FOR ALL USING (auth.role() = 'service_role' OR tenant_id = NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid);
DROP POLICY IF EXISTS tenant_iso_jwt_marketing_performance ON marketing_performance;
CREATE POLICY tenant_iso_jwt_marketing_performance ON marketing_performance FOR ALL USING (auth.role() = 'service_role' OR tenant_id = NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid);
DROP POLICY IF EXISTS tenant_iso_jwt_jobs ON jobs;
CREATE POLICY tenant_iso_jwt_jobs ON jobs FOR ALL USING (auth.role() = 'service_role' OR tenant_id = NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid);
DROP POLICY IF EXISTS tenant_iso_jwt_job_photos ON job_photos;
CREATE POLICY tenant_iso_jwt_job_photos ON job_photos FOR ALL USING (auth.role() = 'service_role' OR tenant_id = NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid);
DROP POLICY IF EXISTS tenant_iso_jwt_meetings ON meetings;
CREATE POLICY tenant_iso_jwt_meetings ON meetings FOR ALL USING (auth.role() = 'service_role' OR tenant_id = NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid);
DROP POLICY IF EXISTS tenant_iso_jwt_finance_entries ON finance_entries;
CREATE POLICY tenant_iso_jwt_finance_entries ON finance_entries FOR ALL USING (auth.role() = 'service_role' OR tenant_id = NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid);
DROP POLICY IF EXISTS tenant_iso_jwt_finance_audit_log ON finance_audit_log;
CREATE POLICY tenant_iso_jwt_finance_audit_log ON finance_audit_log FOR ALL USING (auth.role() = 'service_role' OR tenant_id = NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid);
DROP POLICY IF EXISTS tenant_iso_jwt_finance_period_locks ON finance_period_locks;
CREATE POLICY tenant_iso_jwt_finance_period_locks ON finance_period_locks FOR ALL USING (auth.role() = 'service_role' OR tenant_id = NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid);
DROP POLICY IF EXISTS tenant_iso_jwt_crew_members ON crew_members;
CREATE POLICY tenant_iso_jwt_crew_members ON crew_members FOR ALL USING (auth.role() = 'service_role' OR tenant_id = NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid);
DROP POLICY IF EXISTS tenant_iso_jwt_crew_daily_log ON crew_daily_log;
CREATE POLICY tenant_iso_jwt_crew_daily_log ON crew_daily_log FOR ALL USING (auth.role() = 'service_role' OR tenant_id = NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid);
DROP POLICY IF EXISTS tenant_iso_jwt_debt_tracker ON debt_tracker;
CREATE POLICY tenant_iso_jwt_debt_tracker ON debt_tracker FOR ALL USING (auth.role() = 'service_role' OR tenant_id = NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid);
DROP POLICY IF EXISTS tenant_iso_jwt_voice_calls ON voice_calls;
CREATE POLICY tenant_iso_jwt_voice_calls ON voice_calls FOR ALL USING (auth.role() = 'service_role' OR tenant_id = NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid);
DROP POLICY IF EXISTS tenant_iso_jwt_support_threads ON support_threads;
CREATE POLICY tenant_iso_jwt_support_threads ON support_threads FOR ALL USING (auth.role() = 'service_role' OR tenant_id = NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid);
DROP POLICY IF EXISTS tenant_iso_jwt_support_messages ON support_messages;
CREATE POLICY tenant_iso_jwt_support_messages ON support_messages FOR ALL USING (auth.role() = 'service_role' OR thread_id IN (SELECT id FROM support_threads WHERE tenant_id = NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid));
DROP POLICY IF EXISTS tenant_iso_jwt_push_devices ON push_devices;
CREATE POLICY tenant_iso_jwt_push_devices ON push_devices FOR ALL USING (auth.role() = 'service_role' OR tenant_id = NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid);
DROP POLICY IF EXISTS tenant_iso_jwt_notifications ON notifications;
CREATE POLICY tenant_iso_jwt_notifications ON notifications FOR ALL USING (auth.role() = 'service_role' OR tenant_id = NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid);
DROP POLICY IF EXISTS tenant_iso_jwt_attention_queue ON attention_queue;
CREATE POLICY tenant_iso_jwt_attention_queue ON attention_queue FOR ALL USING (auth.role() = 'service_role' OR tenant_id = NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid);
DROP POLICY IF EXISTS tenant_iso_jwt_scheduled_emails ON scheduled_emails;
CREATE POLICY tenant_iso_jwt_scheduled_emails ON scheduled_emails FOR ALL USING (auth.role() = 'service_role' OR tenant_id = NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid);
DROP POLICY IF EXISTS tenant_iso_jwt_referral_credits ON referral_credits;
CREATE POLICY tenant_iso_jwt_referral_credits ON referral_credits FOR ALL USING (auth.role() = 'service_role' OR tenant_id = NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid);
DROP POLICY IF EXISTS tenant_iso_jwt_sales_tax_registrations ON sales_tax_registrations;
CREATE POLICY tenant_iso_jwt_sales_tax_registrations ON sales_tax_registrations FOR ALL USING (auth.role() = 'service_role' OR tenant_id = NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid);
DROP POLICY IF EXISTS tenant_iso_jwt_cpa_api_tokens ON cpa_api_tokens;
CREATE POLICY tenant_iso_jwt_cpa_api_tokens ON cpa_api_tokens FOR ALL USING (auth.role() = 'service_role' OR tenant_id = NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid);
DROP POLICY IF EXISTS tenant_iso_jwt_tenant_metrics_snapshots ON tenant_metrics_snapshots;
CREATE POLICY tenant_iso_jwt_tenant_metrics_snapshots ON tenant_metrics_snapshots FOR ALL USING (auth.role() = 'service_role' OR tenant_id = NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid);
DROP POLICY IF EXISTS tenant_iso_jwt_meeting_briefings ON meeting_briefings;
CREATE POLICY tenant_iso_jwt_meeting_briefings ON meeting_briefings FOR ALL USING (auth.role() = 'service_role' OR tenant_id = NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid);
DROP POLICY IF EXISTS tenant_iso_jwt_marketing_performance_reports ON marketing_performance_reports;
CREATE POLICY tenant_iso_jwt_marketing_performance_reports ON marketing_performance_reports FOR ALL USING (auth.role() = 'service_role' OR tenant_id = NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid);
DROP POLICY IF EXISTS tenant_iso_jwt_idempotency_keys ON idempotency_keys;
CREATE POLICY tenant_iso_jwt_idempotency_keys ON idempotency_keys FOR ALL USING (auth.role() = 'service_role' OR tenant_id = NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid);
DROP POLICY IF EXISTS tenant_iso_jwt_tenant_websites ON tenant_websites;
CREATE POLICY tenant_iso_jwt_tenant_websites ON tenant_websites FOR ALL USING (auth.role() = 'service_role' OR tenant_id = NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid);
