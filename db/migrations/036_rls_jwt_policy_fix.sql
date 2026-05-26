-- ===========================================================================
-- 036 — Fix the JWT path in the JWT-keyed RLS policies from migration 035
-- ===========================================================================
--
-- Migration 035 wrote policies like:
--   USING (auth.role() = 'service_role' OR tenant_id::text = auth.jwt() ->> 'tenant_id')
--
-- That's wrong. In Supabase's JWT, custom claims like tenant_id live inside
-- the `app_metadata` (set by the backend at provisioning time) or
-- `user_metadata` (set by self-serve flows). They are NOT top-level. The
-- 035 policies therefore compare tenant_id against NULL and never match
-- under a user-JWT client, which means the database would refuse every
-- read and write from a user-JWT-backed route.
--
-- Today the bug is invisible because every route still uses the
-- service-role client (which bypasses RLS). The first route we switch to
-- `getUserClient(req)` would break loudly. This migration fixes the JWT
-- path BEFORE any switch happens.
--
-- HOW IT WORKS
--   1. Define a SECURITY DEFINER function `app.current_tenant_id()` that
--      reads tenant_id from `app_metadata` first, falling back to
--      `user_metadata`. STABLE so PostgreSQL can cache it per query.
--   2. Drop every policy created by 035.
--   3. Re-create each one against `app.current_tenant_id()`.
--   4. Service-role bypass is unchanged (auth.role() check stays).
--
-- HOW TO APPLY
--   cd growth-os && npm run migrate
--
-- ROLLBACK
--   See block at the bottom.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Helper function — reads tenant_id from the current JWT, app_metadata
--    first then user_metadata. Returns NULL if neither is set (which means
--    no rows will match → fail-closed for tenant tables).
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS app;

CREATE OR REPLACE FUNCTION app.current_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT COALESCE(
    NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid,
    NULLIF(auth.jwt() -> 'user_metadata' ->> 'tenant_id', '')::uuid
  );
$$;

COMMENT ON FUNCTION app.current_tenant_id() IS
  'Returns the tenant_id claim from the current Supabase JWT, app_metadata first then user_metadata. NULL if absent.';

-- ---------------------------------------------------------------------------
-- 2 + 3. Drop the 035 policies and recreate against the helper. Each block
--        wraps DROP + CREATE so a re-run is idempotent.
-- ---------------------------------------------------------------------------

-- macro helper, expanded per table below since plpgsql DO blocks would
-- complicate IDE syntax-checking. Each block is identical shape.

-- tenants
DROP POLICY IF EXISTS tenant_iso_jwt_tenants ON tenants;
CREATE POLICY tenant_iso_jwt_tenants ON tenants
  FOR ALL
  USING (auth.role() = 'service_role' OR id = app.current_tenant_id());

-- tenant_users
DROP POLICY IF EXISTS tenant_iso_jwt_tenant_users ON tenant_users;
CREATE POLICY tenant_iso_jwt_tenant_users ON tenant_users
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id = app.current_tenant_id());

-- tenant_config
DROP POLICY IF EXISTS tenant_iso_jwt_tenant_config ON tenant_config;
CREATE POLICY tenant_iso_jwt_tenant_config ON tenant_config
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id = app.current_tenant_id());

-- tenant_modules
DROP POLICY IF EXISTS tenant_iso_jwt_tenant_modules ON tenant_modules;
CREATE POLICY tenant_iso_jwt_tenant_modules ON tenant_modules
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id = app.current_tenant_id());

-- tenant_integrations
DROP POLICY IF EXISTS tenant_iso_jwt_tenant_integrations ON tenant_integrations;
CREATE POLICY tenant_iso_jwt_tenant_integrations ON tenant_integrations
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id = app.current_tenant_id());

-- tenant_usage
DROP POLICY IF EXISTS tenant_iso_jwt_tenant_usage ON tenant_usage;
CREATE POLICY tenant_iso_jwt_tenant_usage ON tenant_usage
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id = app.current_tenant_id());

-- leads
DROP POLICY IF EXISTS tenant_iso_jwt_leads ON leads;
CREATE POLICY tenant_iso_jwt_leads ON leads
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id = app.current_tenant_id());

-- contacts
DROP POLICY IF EXISTS tenant_iso_jwt_contacts ON contacts;
CREATE POLICY tenant_iso_jwt_contacts ON contacts
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id = app.current_tenant_id());

-- messages
DROP POLICY IF EXISTS tenant_iso_jwt_messages ON messages;
CREATE POLICY tenant_iso_jwt_messages ON messages
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id = app.current_tenant_id());

-- conversations
DROP POLICY IF EXISTS tenant_iso_jwt_conversations ON conversations;
CREATE POLICY tenant_iso_jwt_conversations ON conversations
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id = app.current_tenant_id());

-- outreach_sequences
DROP POLICY IF EXISTS tenant_iso_jwt_outreach_sequences ON outreach_sequences;
CREATE POLICY tenant_iso_jwt_outreach_sequences ON outreach_sequences
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id = app.current_tenant_id());

-- outreach_campaigns
DROP POLICY IF EXISTS tenant_iso_jwt_outreach_campaigns ON outreach_campaigns;
CREATE POLICY tenant_iso_jwt_outreach_campaigns ON outreach_campaigns
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id = app.current_tenant_id());

-- activity_log
DROP POLICY IF EXISTS tenant_iso_jwt_activity_log ON activity_log;
CREATE POLICY tenant_iso_jwt_activity_log ON activity_log
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id = app.current_tenant_id());

-- agent_activity_log
DROP POLICY IF EXISTS tenant_iso_jwt_agent_activity_log ON agent_activity_log;
CREATE POLICY tenant_iso_jwt_agent_activity_log ON agent_activity_log
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id = app.current_tenant_id());

-- agent_jobs
DROP POLICY IF EXISTS tenant_iso_jwt_agent_jobs ON agent_jobs;
CREATE POLICY tenant_iso_jwt_agent_jobs ON agent_jobs
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id = app.current_tenant_id());

-- content_drafts
DROP POLICY IF EXISTS tenant_iso_jwt_content_drafts ON content_drafts;
CREATE POLICY tenant_iso_jwt_content_drafts ON content_drafts
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id = app.current_tenant_id());

-- marketing_performance
DROP POLICY IF EXISTS tenant_iso_jwt_marketing_performance ON marketing_performance;
CREATE POLICY tenant_iso_jwt_marketing_performance ON marketing_performance
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id = app.current_tenant_id());

-- jobs
DROP POLICY IF EXISTS tenant_iso_jwt_jobs ON jobs;
CREATE POLICY tenant_iso_jwt_jobs ON jobs
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id = app.current_tenant_id());

-- job_photos
DROP POLICY IF EXISTS tenant_iso_jwt_job_photos ON job_photos;
CREATE POLICY tenant_iso_jwt_job_photos ON job_photos
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id = app.current_tenant_id());

-- meetings
DROP POLICY IF EXISTS tenant_iso_jwt_meetings ON meetings;
CREATE POLICY tenant_iso_jwt_meetings ON meetings
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id = app.current_tenant_id());

-- finance_entries
DROP POLICY IF EXISTS tenant_iso_jwt_finance_entries ON finance_entries;
CREATE POLICY tenant_iso_jwt_finance_entries ON finance_entries
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id = app.current_tenant_id());

-- finance_audit_log
DROP POLICY IF EXISTS tenant_iso_jwt_finance_audit_log ON finance_audit_log;
CREATE POLICY tenant_iso_jwt_finance_audit_log ON finance_audit_log
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id = app.current_tenant_id());

-- finance_period_locks
DROP POLICY IF EXISTS tenant_iso_jwt_finance_period_locks ON finance_period_locks;
CREATE POLICY tenant_iso_jwt_finance_period_locks ON finance_period_locks
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id = app.current_tenant_id());

-- crew_members
DROP POLICY IF EXISTS tenant_iso_jwt_crew_members ON crew_members;
CREATE POLICY tenant_iso_jwt_crew_members ON crew_members
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id = app.current_tenant_id());

-- crew_daily_log
DROP POLICY IF EXISTS tenant_iso_jwt_crew_daily_log ON crew_daily_log;
CREATE POLICY tenant_iso_jwt_crew_daily_log ON crew_daily_log
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id = app.current_tenant_id());

-- debt_tracker
DROP POLICY IF EXISTS tenant_iso_jwt_debt_tracker ON debt_tracker;
CREATE POLICY tenant_iso_jwt_debt_tracker ON debt_tracker
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id = app.current_tenant_id());

-- voice_calls
DROP POLICY IF EXISTS tenant_iso_jwt_voice_calls ON voice_calls;
CREATE POLICY tenant_iso_jwt_voice_calls ON voice_calls
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id = app.current_tenant_id());

-- support_threads
DROP POLICY IF EXISTS tenant_iso_jwt_support_threads ON support_threads;
CREATE POLICY tenant_iso_jwt_support_threads ON support_threads
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id = app.current_tenant_id());

-- support_messages
DROP POLICY IF EXISTS tenant_iso_jwt_support_messages ON support_messages;
CREATE POLICY tenant_iso_jwt_support_messages ON support_messages
  FOR ALL
  USING (
    auth.role() = 'service_role'
    OR thread_id IN (
      SELECT id FROM support_threads
      WHERE tenant_id = app.current_tenant_id()
    )
  );

-- push_devices
DROP POLICY IF EXISTS tenant_iso_jwt_push_devices ON push_devices;
CREATE POLICY tenant_iso_jwt_push_devices ON push_devices
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id = app.current_tenant_id());

-- notifications
DROP POLICY IF EXISTS tenant_iso_jwt_notifications ON notifications;
CREATE POLICY tenant_iso_jwt_notifications ON notifications
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id = app.current_tenant_id());

-- attention_queue
DROP POLICY IF EXISTS tenant_iso_jwt_attention_queue ON attention_queue;
CREATE POLICY tenant_iso_jwt_attention_queue ON attention_queue
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id = app.current_tenant_id());

-- scheduled_emails
DROP POLICY IF EXISTS tenant_iso_jwt_scheduled_emails ON scheduled_emails;
CREATE POLICY tenant_iso_jwt_scheduled_emails ON scheduled_emails
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id = app.current_tenant_id());

-- referral_credits
DROP POLICY IF EXISTS tenant_iso_jwt_referral_credits ON referral_credits;
CREATE POLICY tenant_iso_jwt_referral_credits ON referral_credits
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id = app.current_tenant_id());

-- sales_tax_registrations
DROP POLICY IF EXISTS tenant_iso_jwt_sales_tax_registrations ON sales_tax_registrations;
CREATE POLICY tenant_iso_jwt_sales_tax_registrations ON sales_tax_registrations
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id = app.current_tenant_id());

-- cpa_api_tokens
DROP POLICY IF EXISTS tenant_iso_jwt_cpa_api_tokens ON cpa_api_tokens;
CREATE POLICY tenant_iso_jwt_cpa_api_tokens ON cpa_api_tokens
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id = app.current_tenant_id());

-- tenant_metrics_snapshots
DROP POLICY IF EXISTS tenant_iso_jwt_tenant_metrics_snapshots ON tenant_metrics_snapshots;
CREATE POLICY tenant_iso_jwt_tenant_metrics_snapshots ON tenant_metrics_snapshots
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id = app.current_tenant_id());

-- meeting_briefings
DROP POLICY IF EXISTS tenant_iso_jwt_meeting_briefings ON meeting_briefings;
CREATE POLICY tenant_iso_jwt_meeting_briefings ON meeting_briefings
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id = app.current_tenant_id());

-- marketing_performance_reports
DROP POLICY IF EXISTS tenant_iso_jwt_marketing_performance_reports ON marketing_performance_reports;
CREATE POLICY tenant_iso_jwt_marketing_performance_reports ON marketing_performance_reports
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id = app.current_tenant_id());

-- idempotency_keys
DROP POLICY IF EXISTS tenant_iso_jwt_idempotency_keys ON idempotency_keys;
CREATE POLICY tenant_iso_jwt_idempotency_keys ON idempotency_keys
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id = app.current_tenant_id());

-- tenant_websites
DROP POLICY IF EXISTS tenant_iso_jwt_tenant_websites ON tenant_websites;
CREATE POLICY tenant_iso_jwt_tenant_websites ON tenant_websites
  FOR ALL
  USING (auth.role() = 'service_role' OR tenant_id = app.current_tenant_id());

-- ---------------------------------------------------------------------------
-- Rollback
-- ---------------------------------------------------------------------------
-- -- 1. Drop each new policy (they have the same names as 035's, so the
-- --    same DROP block from 035's rollback works).
-- -- 2. Drop the helper:
-- --      DROP FUNCTION IF EXISTS app.current_tenant_id();
-- --      DROP SCHEMA IF EXISTS app;
