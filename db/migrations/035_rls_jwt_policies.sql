-- ===========================================================================
-- 035 — Additive JWT-keyed RLS policies for true tenant isolation
-- ===========================================================================
--
-- WHY THIS EXISTS
--   Migrations 003 / 005 / 007 / 008 / 009 / 012 / 013 / 014 / 017 / 018 / 020
--   / 021 / 023 / 024 / 025 / 028 / 029 / 030 / 032 / 034 already enabled RLS
--   on every tenant-scoped table, but the policies key on the session variable
--   `app.tenant_id`. That variable is set by a Postgres RPC named
--   `set_tenant_context` which the API server NEVER calls. Combined with the
--   fact that every API route creates its Supabase client via the
--   service-role key (which bypasses RLS by Supabase's default), the existing
--   policies provide zero enforcement for live traffic.
--
--   This migration adds a SECOND policy to every tenant-scoped table. The
--   new policy fires when the caller has a valid user JWT — the kind of
--   client the new `getUserClient(req)` helper (api/lib/userClient.js)
--   produces. Service-role keeps bypassing as before, so:
--
--     - Admin routes that use service-role: NO behavior change (they cross
--       tenants intentionally).
--     - Worker agents that use service-role: NO behavior change.
--     - Routes that we later switch to `getUserClient(req)`: automatic
--       tenant_id enforcement at the database, even if the application
--       code forgets a WHERE clause.
--
-- WHY IT'S SAFE TO APPLY TO PRODUCTION
--   Every existing query path uses service-role and continues to bypass RLS.
--   The new policies only have an effect for non-service-role JWTs, and
--   nothing in the codebase currently issues those requests against any
--   tenant table. Applying this migration is functionally a no-op today,
--   but every route we switch tomorrow gets isolation for free.
--
-- HOW TO APPLY
--   cd growth-os && npm run migrate
--
-- HOW TO ROLLBACK
--   See "Rollback" block at the bottom of this file. Each CREATE POLICY is
--   commented with its corresponding DROP POLICY.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Helper note: auth.jwt() and auth.role() are PostgreSQL functions Supabase
-- provides inside RLS policies. They read the bearer JWT attached to the
-- current request.
--
--   auth.role() returns 'service_role' for service-role clients, 'authenticated'
--   for user-JWT clients, and 'anon' for anonymous public keys.
--
--   auth.jwt() returns the JWT claims as a JSONB. We expect tenants to have
--   `tenant_id` set in their app_metadata, which Supabase puts in the JWT
--   under that same key.
-- ---------------------------------------------------------------------------

-- Core tenant identity tables
CREATE POLICY tenant_iso_jwt_tenants ON tenants
  FOR ALL
  USING (auth.role() = 'service_role' OR id::text = auth.jwt() ->> 'tenant_id');

CREATE POLICY tenant_iso_jwt_tenant_users ON tenant_users
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id::text = auth.jwt() ->> 'tenant_id');

CREATE POLICY tenant_iso_jwt_tenant_config ON tenant_config
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id::text = auth.jwt() ->> 'tenant_id');

CREATE POLICY tenant_iso_jwt_tenant_modules ON tenant_modules
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id::text = auth.jwt() ->> 'tenant_id');

CREATE POLICY tenant_iso_jwt_tenant_integrations ON tenant_integrations
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id::text = auth.jwt() ->> 'tenant_id');

CREATE POLICY tenant_iso_jwt_tenant_usage ON tenant_usage
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id::text = auth.jwt() ->> 'tenant_id');

-- Leads + CRM
CREATE POLICY tenant_iso_jwt_leads ON leads
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id::text = auth.jwt() ->> 'tenant_id');

CREATE POLICY tenant_iso_jwt_contacts ON contacts
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id::text = auth.jwt() ->> 'tenant_id');

CREATE POLICY tenant_iso_jwt_messages ON messages
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id::text = auth.jwt() ->> 'tenant_id');

CREATE POLICY tenant_iso_jwt_conversations ON conversations
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id::text = auth.jwt() ->> 'tenant_id');

CREATE POLICY tenant_iso_jwt_outreach_sequences ON outreach_sequences
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id::text = auth.jwt() ->> 'tenant_id');

CREATE POLICY tenant_iso_jwt_outreach_campaigns ON outreach_campaigns
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id::text = auth.jwt() ->> 'tenant_id');

CREATE POLICY tenant_iso_jwt_activity_log ON activity_log
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id::text = auth.jwt() ->> 'tenant_id');

CREATE POLICY tenant_iso_jwt_agent_activity_log ON agent_activity_log
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id::text = auth.jwt() ->> 'tenant_id');

CREATE POLICY tenant_iso_jwt_agent_jobs ON agent_jobs
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id::text = auth.jwt() ->> 'tenant_id');

-- Content / marketing
CREATE POLICY tenant_iso_jwt_content_drafts ON content_drafts
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id::text = auth.jwt() ->> 'tenant_id');

CREATE POLICY tenant_iso_jwt_marketing_performance ON marketing_performance
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id::text = auth.jwt() ->> 'tenant_id');

-- Jobs + photos + meetings
CREATE POLICY tenant_iso_jwt_jobs ON jobs
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id::text = auth.jwt() ->> 'tenant_id');

CREATE POLICY tenant_iso_jwt_job_photos ON job_photos
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id::text = auth.jwt() ->> 'tenant_id');

CREATE POLICY tenant_iso_jwt_meetings ON meetings
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id::text = auth.jwt() ->> 'tenant_id');

-- Finance
CREATE POLICY tenant_iso_jwt_finance_entries ON finance_entries
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id::text = auth.jwt() ->> 'tenant_id');

CREATE POLICY tenant_iso_jwt_finance_audit_log ON finance_audit_log
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id::text = auth.jwt() ->> 'tenant_id');

CREATE POLICY tenant_iso_jwt_finance_period_locks ON finance_period_locks
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id::text = auth.jwt() ->> 'tenant_id');

-- Crew / employees
CREATE POLICY tenant_iso_jwt_crew_members ON crew_members
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id::text = auth.jwt() ->> 'tenant_id');

CREATE POLICY tenant_iso_jwt_crew_daily_log ON crew_daily_log
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id::text = auth.jwt() ->> 'tenant_id');

-- Debt
CREATE POLICY tenant_iso_jwt_debt_tracker ON debt_tracker
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id::text = auth.jwt() ->> 'tenant_id');

-- Voice / support / notifications
CREATE POLICY tenant_iso_jwt_voice_calls ON voice_calls
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id::text = auth.jwt() ->> 'tenant_id');

CREATE POLICY tenant_iso_jwt_support_tickets ON support_tickets
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id::text = auth.jwt() ->> 'tenant_id');

CREATE POLICY tenant_iso_jwt_support_threads ON support_threads
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id::text = auth.jwt() ->> 'tenant_id');

CREATE POLICY tenant_iso_jwt_support_messages ON support_messages
  FOR ALL
  USING (
    auth.role() = 'service_role'
    OR thread_id IN (
      SELECT id FROM support_threads
      WHERE tenant_id::text = auth.jwt() ->> 'tenant_id'
    )
  );

CREATE POLICY tenant_iso_jwt_push_devices ON push_devices
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id::text = auth.jwt() ->> 'tenant_id');

CREATE POLICY tenant_iso_jwt_notifications ON notifications
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id::text = auth.jwt() ->> 'tenant_id');

CREATE POLICY tenant_iso_jwt_attention_queue ON attention_queue
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id::text = auth.jwt() ->> 'tenant_id');

-- Onboarding + lifecycle
CREATE POLICY tenant_iso_jwt_onboarding_workflows ON onboarding_workflows
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id::text = auth.jwt() ->> 'tenant_id');

CREATE POLICY tenant_iso_jwt_onboarding_steps ON onboarding_steps
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id::text = auth.jwt() ->> 'tenant_id');

CREATE POLICY tenant_iso_jwt_account_health_log ON account_health_log
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id::text = auth.jwt() ->> 'tenant_id');

CREATE POLICY tenant_iso_jwt_account_alerts ON account_alerts
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id::text = auth.jwt() ->> 'tenant_id');

CREATE POLICY tenant_iso_jwt_lifecycle_events ON lifecycle_events
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id::text = auth.jwt() ->> 'tenant_id');

-- Emails + referrals + tax + CPA
CREATE POLICY tenant_iso_jwt_scheduled_emails ON scheduled_emails
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id::text = auth.jwt() ->> 'tenant_id');

CREATE POLICY tenant_iso_jwt_referral_credits ON referral_credits
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id::text = auth.jwt() ->> 'tenant_id');

CREATE POLICY tenant_iso_jwt_sales_tax_registrations ON sales_tax_registrations
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id::text = auth.jwt() ->> 'tenant_id');

CREATE POLICY tenant_iso_jwt_cpa_api_tokens ON cpa_api_tokens
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id::text = auth.jwt() ->> 'tenant_id');

-- Metrics
CREATE POLICY tenant_iso_jwt_tenant_metrics_snapshots ON tenant_metrics_snapshots
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id::text = auth.jwt() ->> 'tenant_id');

CREATE POLICY tenant_iso_jwt_meeting_briefings ON meeting_briefings
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id::text = auth.jwt() ->> 'tenant_id');

CREATE POLICY tenant_iso_jwt_marketing_performance_reports ON marketing_performance_reports
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id::text = auth.jwt() ->> 'tenant_id');

CREATE POLICY tenant_iso_jwt_idempotency_keys ON idempotency_keys
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id::text = auth.jwt() ->> 'tenant_id');

CREATE POLICY tenant_iso_jwt_tenant_websites ON tenant_websites
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id::text = auth.jwt() ->> 'tenant_id');

-- ---------------------------------------------------------------------------
-- Rollback (if anything goes sideways, run this in a SQL console)
-- ---------------------------------------------------------------------------
--
-- DROP POLICY IF EXISTS tenant_iso_jwt_tenants                     ON tenants;
-- DROP POLICY IF EXISTS tenant_iso_jwt_tenant_users                ON tenant_users;
-- DROP POLICY IF EXISTS tenant_iso_jwt_tenant_config               ON tenant_config;
-- DROP POLICY IF EXISTS tenant_iso_jwt_tenant_modules              ON tenant_modules;
-- DROP POLICY IF EXISTS tenant_iso_jwt_tenant_integrations         ON tenant_integrations;
-- DROP POLICY IF EXISTS tenant_iso_jwt_tenant_usage                ON tenant_usage;
-- DROP POLICY IF EXISTS tenant_iso_jwt_leads                       ON leads;
-- DROP POLICY IF EXISTS tenant_iso_jwt_contacts                    ON contacts;
-- DROP POLICY IF EXISTS tenant_iso_jwt_messages                    ON messages;
-- DROP POLICY IF EXISTS tenant_iso_jwt_conversations               ON conversations;
-- DROP POLICY IF EXISTS tenant_iso_jwt_outreach_sequences          ON outreach_sequences;
-- DROP POLICY IF EXISTS tenant_iso_jwt_outreach_campaigns          ON outreach_campaigns;
-- DROP POLICY IF EXISTS tenant_iso_jwt_activity_log                ON activity_log;
-- DROP POLICY IF EXISTS tenant_iso_jwt_agent_activity_log          ON agent_activity_log;
-- DROP POLICY IF EXISTS tenant_iso_jwt_agent_jobs                  ON agent_jobs;
-- DROP POLICY IF EXISTS tenant_iso_jwt_content_drafts              ON content_drafts;
-- DROP POLICY IF EXISTS tenant_iso_jwt_marketing_performance       ON marketing_performance;
-- DROP POLICY IF EXISTS tenant_iso_jwt_jobs                        ON jobs;
-- DROP POLICY IF EXISTS tenant_iso_jwt_job_photos                  ON job_photos;
-- DROP POLICY IF EXISTS tenant_iso_jwt_meetings                    ON meetings;
-- DROP POLICY IF EXISTS tenant_iso_jwt_finance_entries             ON finance_entries;
-- DROP POLICY IF EXISTS tenant_iso_jwt_finance_audit_log           ON finance_audit_log;
-- DROP POLICY IF EXISTS tenant_iso_jwt_finance_period_locks        ON finance_period_locks;
-- DROP POLICY IF EXISTS tenant_iso_jwt_crew_members                ON crew_members;
-- DROP POLICY IF EXISTS tenant_iso_jwt_crew_daily_log              ON crew_daily_log;
-- DROP POLICY IF EXISTS tenant_iso_jwt_debt_tracker                ON debt_tracker;
-- DROP POLICY IF EXISTS tenant_iso_jwt_voice_calls                 ON voice_calls;
-- DROP POLICY IF EXISTS tenant_iso_jwt_support_tickets             ON support_tickets;
-- DROP POLICY IF EXISTS tenant_iso_jwt_support_threads             ON support_threads;
-- DROP POLICY IF EXISTS tenant_iso_jwt_support_messages            ON support_messages;
-- DROP POLICY IF EXISTS tenant_iso_jwt_push_devices                ON push_devices;
-- DROP POLICY IF EXISTS tenant_iso_jwt_notifications               ON notifications;
-- DROP POLICY IF EXISTS tenant_iso_jwt_attention_queue             ON attention_queue;
-- DROP POLICY IF EXISTS tenant_iso_jwt_onboarding_workflows        ON onboarding_workflows;
-- DROP POLICY IF EXISTS tenant_iso_jwt_onboarding_steps            ON onboarding_steps;
-- DROP POLICY IF EXISTS tenant_iso_jwt_account_health_log          ON account_health_log;
-- DROP POLICY IF EXISTS tenant_iso_jwt_account_alerts              ON account_alerts;
-- DROP POLICY IF EXISTS tenant_iso_jwt_lifecycle_events            ON lifecycle_events;
-- DROP POLICY IF EXISTS tenant_iso_jwt_scheduled_emails            ON scheduled_emails;
-- DROP POLICY IF EXISTS tenant_iso_jwt_referral_credits            ON referral_credits;
-- DROP POLICY IF EXISTS tenant_iso_jwt_sales_tax_registrations     ON sales_tax_registrations;
-- DROP POLICY IF EXISTS tenant_iso_jwt_cpa_api_tokens              ON cpa_api_tokens;
-- DROP POLICY IF EXISTS tenant_iso_jwt_tenant_metrics_snapshots    ON tenant_metrics_snapshots;
-- DROP POLICY IF EXISTS tenant_iso_jwt_meeting_briefings           ON meeting_briefings;
-- DROP POLICY IF EXISTS tenant_iso_jwt_marketing_performance_reports ON marketing_performance_reports;
-- DROP POLICY IF EXISTS tenant_iso_jwt_idempotency_keys            ON idempotency_keys;
-- DROP POLICY IF EXISTS tenant_iso_jwt_tenant_websites             ON tenant_websites;
