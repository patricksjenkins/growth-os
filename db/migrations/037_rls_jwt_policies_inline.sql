-- ===========================================================================
-- 037 — JWT-keyed RLS policies, INLINE (no function, no schema)
-- ===========================================================================
--
-- WHY THIS EXISTS
--   Migration 036 tried to create a SECURITY INVOKER function
--   app.current_tenant_id() and reference it from every policy. The
--   migration runner at scripts/migrate.js naively splits SQL on `;`,
--   which broke the dollar-quoted function body and left the schema +
--   function uncreated. Result: 036 ran with 44 warnings ("schema 'app'
--   does not exist") and ZERO policies were created. Combined with
--   035's DROP POLICY statements (which DID execute as plain
--   statements), the database is currently in a state where the
--   JWT-keyed policies don't exist at all.
--
-- WHAT THIS DOES
--   Recreates every policy from 036 but with the COALESCE expression
--   inlined directly into the policy's USING clause. Every statement
--   in this file is a single-line / single-statement SQL block that
--   the naive splitter handles correctly. No functions, no schemas.
--
-- HOW TO APPLY
--   cd growth-os && npm run migrate
--
-- IDEMPOTENT
--   Every CREATE POLICY is preceded by DROP POLICY IF EXISTS, so
--   running this file twice has the same result as running it once.
--
-- AFTER APPLYING
--   The first user-JWT route switch (POST /api/tenant/clients, see
--   api/routes/tenant.js) will start enforcing tenant_id at the
--   database layer. Service-role bypass is preserved on every policy
--   so admin endpoints and worker agents are unaffected.
-- ===========================================================================

-- tenants
DROP POLICY IF EXISTS tenant_iso_jwt_tenants ON tenants;
CREATE POLICY tenant_iso_jwt_tenants ON tenants FOR ALL USING (auth.role() = 'service_role' OR id = COALESCE(NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid, NULLIF(auth.jwt() -> 'user_metadata' ->> 'tenant_id', '')::uuid));

-- tenant_users
DROP POLICY IF EXISTS tenant_iso_jwt_tenant_users ON tenant_users;
CREATE POLICY tenant_iso_jwt_tenant_users ON tenant_users FOR ALL USING (auth.role() = 'service_role' OR tenant_id = COALESCE(NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid, NULLIF(auth.jwt() -> 'user_metadata' ->> 'tenant_id', '')::uuid));

-- tenant_config
DROP POLICY IF EXISTS tenant_iso_jwt_tenant_config ON tenant_config;
CREATE POLICY tenant_iso_jwt_tenant_config ON tenant_config FOR ALL USING (auth.role() = 'service_role' OR tenant_id = COALESCE(NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid, NULLIF(auth.jwt() -> 'user_metadata' ->> 'tenant_id', '')::uuid));

-- tenant_modules
DROP POLICY IF EXISTS tenant_iso_jwt_tenant_modules ON tenant_modules;
CREATE POLICY tenant_iso_jwt_tenant_modules ON tenant_modules FOR ALL USING (auth.role() = 'service_role' OR tenant_id = COALESCE(NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid, NULLIF(auth.jwt() -> 'user_metadata' ->> 'tenant_id', '')::uuid));

-- tenant_integrations
DROP POLICY IF EXISTS tenant_iso_jwt_tenant_integrations ON tenant_integrations;
CREATE POLICY tenant_iso_jwt_tenant_integrations ON tenant_integrations FOR ALL USING (auth.role() = 'service_role' OR tenant_id = COALESCE(NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid, NULLIF(auth.jwt() -> 'user_metadata' ->> 'tenant_id', '')::uuid));

-- tenant_usage
DROP POLICY IF EXISTS tenant_iso_jwt_tenant_usage ON tenant_usage;
CREATE POLICY tenant_iso_jwt_tenant_usage ON tenant_usage FOR ALL USING (auth.role() = 'service_role' OR tenant_id = COALESCE(NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid, NULLIF(auth.jwt() -> 'user_metadata' ->> 'tenant_id', '')::uuid));

-- leads
DROP POLICY IF EXISTS tenant_iso_jwt_leads ON leads;
CREATE POLICY tenant_iso_jwt_leads ON leads FOR ALL USING (auth.role() = 'service_role' OR tenant_id = COALESCE(NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid, NULLIF(auth.jwt() -> 'user_metadata' ->> 'tenant_id', '')::uuid));

-- contacts
DROP POLICY IF EXISTS tenant_iso_jwt_contacts ON contacts;
CREATE POLICY tenant_iso_jwt_contacts ON contacts FOR ALL USING (auth.role() = 'service_role' OR tenant_id = COALESCE(NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid, NULLIF(auth.jwt() -> 'user_metadata' ->> 'tenant_id', '')::uuid));

-- messages
DROP POLICY IF EXISTS tenant_iso_jwt_messages ON messages;
CREATE POLICY tenant_iso_jwt_messages ON messages FOR ALL USING (auth.role() = 'service_role' OR tenant_id = COALESCE(NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid, NULLIF(auth.jwt() -> 'user_metadata' ->> 'tenant_id', '')::uuid));

-- conversations
DROP POLICY IF EXISTS tenant_iso_jwt_conversations ON conversations;
CREATE POLICY tenant_iso_jwt_conversations ON conversations FOR ALL USING (auth.role() = 'service_role' OR tenant_id = COALESCE(NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid, NULLIF(auth.jwt() -> 'user_metadata' ->> 'tenant_id', '')::uuid));

-- outreach_sequences
DROP POLICY IF EXISTS tenant_iso_jwt_outreach_sequences ON outreach_sequences;
CREATE POLICY tenant_iso_jwt_outreach_sequences ON outreach_sequences FOR ALL USING (auth.role() = 'service_role' OR tenant_id = COALESCE(NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid, NULLIF(auth.jwt() -> 'user_metadata' ->> 'tenant_id', '')::uuid));

-- outreach_campaigns
DROP POLICY IF EXISTS tenant_iso_jwt_outreach_campaigns ON outreach_campaigns;
CREATE POLICY tenant_iso_jwt_outreach_campaigns ON outreach_campaigns FOR ALL USING (auth.role() = 'service_role' OR tenant_id = COALESCE(NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid, NULLIF(auth.jwt() -> 'user_metadata' ->> 'tenant_id', '')::uuid));

-- activity_log
DROP POLICY IF EXISTS tenant_iso_jwt_activity_log ON activity_log;
CREATE POLICY tenant_iso_jwt_activity_log ON activity_log FOR ALL USING (auth.role() = 'service_role' OR tenant_id = COALESCE(NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid, NULLIF(auth.jwt() -> 'user_metadata' ->> 'tenant_id', '')::uuid));

-- agent_activity_log
DROP POLICY IF EXISTS tenant_iso_jwt_agent_activity_log ON agent_activity_log;
CREATE POLICY tenant_iso_jwt_agent_activity_log ON agent_activity_log FOR ALL USING (auth.role() = 'service_role' OR tenant_id = COALESCE(NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid, NULLIF(auth.jwt() -> 'user_metadata' ->> 'tenant_id', '')::uuid));

-- agent_jobs
DROP POLICY IF EXISTS tenant_iso_jwt_agent_jobs ON agent_jobs;
CREATE POLICY tenant_iso_jwt_agent_jobs ON agent_jobs FOR ALL USING (auth.role() = 'service_role' OR tenant_id = COALESCE(NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid, NULLIF(auth.jwt() -> 'user_metadata' ->> 'tenant_id', '')::uuid));

-- content_drafts
DROP POLICY IF EXISTS tenant_iso_jwt_content_drafts ON content_drafts;
CREATE POLICY tenant_iso_jwt_content_drafts ON content_drafts FOR ALL USING (auth.role() = 'service_role' OR tenant_id = COALESCE(NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid, NULLIF(auth.jwt() -> 'user_metadata' ->> 'tenant_id', '')::uuid));

-- marketing_performance
DROP POLICY IF EXISTS tenant_iso_jwt_marketing_performance ON marketing_performance;
CREATE POLICY tenant_iso_jwt_marketing_performance ON marketing_performance FOR ALL USING (auth.role() = 'service_role' OR tenant_id = COALESCE(NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid, NULLIF(auth.jwt() -> 'user_metadata' ->> 'tenant_id', '')::uuid));

-- jobs
DROP POLICY IF EXISTS tenant_iso_jwt_jobs ON jobs;
CREATE POLICY tenant_iso_jwt_jobs ON jobs FOR ALL USING (auth.role() = 'service_role' OR tenant_id = COALESCE(NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid, NULLIF(auth.jwt() -> 'user_metadata' ->> 'tenant_id', '')::uuid));

-- job_photos
DROP POLICY IF EXISTS tenant_iso_jwt_job_photos ON job_photos;
CREATE POLICY tenant_iso_jwt_job_photos ON job_photos FOR ALL USING (auth.role() = 'service_role' OR tenant_id = COALESCE(NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid, NULLIF(auth.jwt() -> 'user_metadata' ->> 'tenant_id', '')::uuid));

-- meetings
DROP POLICY IF EXISTS tenant_iso_jwt_meetings ON meetings;
CREATE POLICY tenant_iso_jwt_meetings ON meetings FOR ALL USING (auth.role() = 'service_role' OR tenant_id = COALESCE(NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid, NULLIF(auth.jwt() -> 'user_metadata' ->> 'tenant_id', '')::uuid));

-- finance_entries
DROP POLICY IF EXISTS tenant_iso_jwt_finance_entries ON finance_entries;
CREATE POLICY tenant_iso_jwt_finance_entries ON finance_entries FOR ALL USING (auth.role() = 'service_role' OR tenant_id = COALESCE(NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid, NULLIF(auth.jwt() -> 'user_metadata' ->> 'tenant_id', '')::uuid));

-- finance_audit_log
DROP POLICY IF EXISTS tenant_iso_jwt_finance_audit_log ON finance_audit_log;
CREATE POLICY tenant_iso_jwt_finance_audit_log ON finance_audit_log FOR ALL USING (auth.role() = 'service_role' OR tenant_id = COALESCE(NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid, NULLIF(auth.jwt() -> 'user_metadata' ->> 'tenant_id', '')::uuid));

-- finance_period_locks
DROP POLICY IF EXISTS tenant_iso_jwt_finance_period_locks ON finance_period_locks;
CREATE POLICY tenant_iso_jwt_finance_period_locks ON finance_period_locks FOR ALL USING (auth.role() = 'service_role' OR tenant_id = COALESCE(NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid, NULLIF(auth.jwt() -> 'user_metadata' ->> 'tenant_id', '')::uuid));

-- crew_members
DROP POLICY IF EXISTS tenant_iso_jwt_crew_members ON crew_members;
CREATE POLICY tenant_iso_jwt_crew_members ON crew_members FOR ALL USING (auth.role() = 'service_role' OR tenant_id = COALESCE(NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid, NULLIF(auth.jwt() -> 'user_metadata' ->> 'tenant_id', '')::uuid));

-- crew_daily_log
DROP POLICY IF EXISTS tenant_iso_jwt_crew_daily_log ON crew_daily_log;
CREATE POLICY tenant_iso_jwt_crew_daily_log ON crew_daily_log FOR ALL USING (auth.role() = 'service_role' OR tenant_id = COALESCE(NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid, NULLIF(auth.jwt() -> 'user_metadata' ->> 'tenant_id', '')::uuid));

-- debt_tracker
DROP POLICY IF EXISTS tenant_iso_jwt_debt_tracker ON debt_tracker;
CREATE POLICY tenant_iso_jwt_debt_tracker ON debt_tracker FOR ALL USING (auth.role() = 'service_role' OR tenant_id = COALESCE(NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid, NULLIF(auth.jwt() -> 'user_metadata' ->> 'tenant_id', '')::uuid));

-- voice_calls
DROP POLICY IF EXISTS tenant_iso_jwt_voice_calls ON voice_calls;
CREATE POLICY tenant_iso_jwt_voice_calls ON voice_calls FOR ALL USING (auth.role() = 'service_role' OR tenant_id = COALESCE(NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid, NULLIF(auth.jwt() -> 'user_metadata' ->> 'tenant_id', '')::uuid));

-- support_threads
DROP POLICY IF EXISTS tenant_iso_jwt_support_threads ON support_threads;
CREATE POLICY tenant_iso_jwt_support_threads ON support_threads FOR ALL USING (auth.role() = 'service_role' OR tenant_id = COALESCE(NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid, NULLIF(auth.jwt() -> 'user_metadata' ->> 'tenant_id', '')::uuid));

-- support_messages (special: joins through parent thread)
DROP POLICY IF EXISTS tenant_iso_jwt_support_messages ON support_messages;
CREATE POLICY tenant_iso_jwt_support_messages ON support_messages FOR ALL USING (auth.role() = 'service_role' OR thread_id IN (SELECT id FROM support_threads WHERE tenant_id = COALESCE(NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid, NULLIF(auth.jwt() -> 'user_metadata' ->> 'tenant_id', '')::uuid)));

-- push_devices
DROP POLICY IF EXISTS tenant_iso_jwt_push_devices ON push_devices;
CREATE POLICY tenant_iso_jwt_push_devices ON push_devices FOR ALL USING (auth.role() = 'service_role' OR tenant_id = COALESCE(NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid, NULLIF(auth.jwt() -> 'user_metadata' ->> 'tenant_id', '')::uuid));

-- notifications
DROP POLICY IF EXISTS tenant_iso_jwt_notifications ON notifications;
CREATE POLICY tenant_iso_jwt_notifications ON notifications FOR ALL USING (auth.role() = 'service_role' OR tenant_id = COALESCE(NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid, NULLIF(auth.jwt() -> 'user_metadata' ->> 'tenant_id', '')::uuid));

-- attention_queue
DROP POLICY IF EXISTS tenant_iso_jwt_attention_queue ON attention_queue;
CREATE POLICY tenant_iso_jwt_attention_queue ON attention_queue FOR ALL USING (auth.role() = 'service_role' OR tenant_id = COALESCE(NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid, NULLIF(auth.jwt() -> 'user_metadata' ->> 'tenant_id', '')::uuid));

-- scheduled_emails
DROP POLICY IF EXISTS tenant_iso_jwt_scheduled_emails ON scheduled_emails;
CREATE POLICY tenant_iso_jwt_scheduled_emails ON scheduled_emails FOR ALL USING (auth.role() = 'service_role' OR tenant_id = COALESCE(NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid, NULLIF(auth.jwt() -> 'user_metadata' ->> 'tenant_id', '')::uuid));

-- referral_credits
DROP POLICY IF EXISTS tenant_iso_jwt_referral_credits ON referral_credits;
CREATE POLICY tenant_iso_jwt_referral_credits ON referral_credits FOR ALL USING (auth.role() = 'service_role' OR tenant_id = COALESCE(NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid, NULLIF(auth.jwt() -> 'user_metadata' ->> 'tenant_id', '')::uuid));

-- sales_tax_registrations
DROP POLICY IF EXISTS tenant_iso_jwt_sales_tax_registrations ON sales_tax_registrations;
CREATE POLICY tenant_iso_jwt_sales_tax_registrations ON sales_tax_registrations FOR ALL USING (auth.role() = 'service_role' OR tenant_id = COALESCE(NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid, NULLIF(auth.jwt() -> 'user_metadata' ->> 'tenant_id', '')::uuid));

-- cpa_api_tokens
DROP POLICY IF EXISTS tenant_iso_jwt_cpa_api_tokens ON cpa_api_tokens;
CREATE POLICY tenant_iso_jwt_cpa_api_tokens ON cpa_api_tokens FOR ALL USING (auth.role() = 'service_role' OR tenant_id = COALESCE(NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid, NULLIF(auth.jwt() -> 'user_metadata' ->> 'tenant_id', '')::uuid));

-- tenant_metrics_snapshots
DROP POLICY IF EXISTS tenant_iso_jwt_tenant_metrics_snapshots ON tenant_metrics_snapshots;
CREATE POLICY tenant_iso_jwt_tenant_metrics_snapshots ON tenant_metrics_snapshots FOR ALL USING (auth.role() = 'service_role' OR tenant_id = COALESCE(NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid, NULLIF(auth.jwt() -> 'user_metadata' ->> 'tenant_id', '')::uuid));

-- meeting_briefings
DROP POLICY IF EXISTS tenant_iso_jwt_meeting_briefings ON meeting_briefings;
CREATE POLICY tenant_iso_jwt_meeting_briefings ON meeting_briefings FOR ALL USING (auth.role() = 'service_role' OR tenant_id = COALESCE(NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid, NULLIF(auth.jwt() -> 'user_metadata' ->> 'tenant_id', '')::uuid));

-- marketing_performance_reports
DROP POLICY IF EXISTS tenant_iso_jwt_marketing_performance_reports ON marketing_performance_reports;
CREATE POLICY tenant_iso_jwt_marketing_performance_reports ON marketing_performance_reports FOR ALL USING (auth.role() = 'service_role' OR tenant_id = COALESCE(NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid, NULLIF(auth.jwt() -> 'user_metadata' ->> 'tenant_id', '')::uuid));

-- idempotency_keys
DROP POLICY IF EXISTS tenant_iso_jwt_idempotency_keys ON idempotency_keys;
CREATE POLICY tenant_iso_jwt_idempotency_keys ON idempotency_keys FOR ALL USING (auth.role() = 'service_role' OR tenant_id = COALESCE(NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid, NULLIF(auth.jwt() -> 'user_metadata' ->> 'tenant_id', '')::uuid));

-- tenant_websites
DROP POLICY IF EXISTS tenant_iso_jwt_tenant_websites ON tenant_websites;
CREATE POLICY tenant_iso_jwt_tenant_websites ON tenant_websites FOR ALL USING (auth.role() = 'service_role' OR tenant_id = COALESCE(NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid, NULLIF(auth.jwt() -> 'user_metadata' ->> 'tenant_id', '')::uuid));
