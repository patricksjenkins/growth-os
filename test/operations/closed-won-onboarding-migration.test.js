'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const migration = fs.readFileSync(
  path.join(root, 'db', 'migrations', '076_closed_won_onboarding_handoff.sql'),
  'utf8'
);
const rollback = fs.readFileSync(
  path.join(root, 'db', 'rollbacks', '076_closed_won_onboarding_handoff_rollback.sql'),
  'utf8'
);

test('migration is additive and does not mutate deployed business tables', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.sales_closed_won_events/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.closed_won_onboarding_handoffs/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.closed_won_onboarding_events/i);
  assert.doesNotMatch(
    migration,
    /(?:ALTER|UPDATE|DELETE FROM|TRUNCATE|DROP TABLE)\s+public\.(?:leads|customers|tenants|onboarding_workflows)/i
  );
  assert.doesNotMatch(migration, /^\s*(?:COMMIT|ROLLBACK)\s*;/im);
});

test('source sales and client onboarding tenant identities are explicit and verified', () => {
  assert.match(migration, /source_tenant_id[\s\S]*client_tenant_id/i);
  assert.match(migration, /lead\.id = p_lead_id[\s\S]*lead\.tenant_id = p_source_tenant_id[\s\S]*lead\.status = 'won'[\s\S]*FOR SHARE/i);
  assert.match(migration, /customer\.id = p_customer_id[\s\S]*customer\.tenant_id = p_source_tenant_id[\s\S]*FOR SHARE/i);
  assert.match(migration, /workflow\.id = p_onboarding_workflow_id[\s\S]*workflow\.tenant_id = p_client_tenant_id[\s\S]*FOR SHARE/i);
  assert.match(migration, /onboarding_workflow_client_tenant_mismatch/i);
  assert.match(migration, /closed_won_customer_tenant_mismatch/i);
  assert.match(migration, /closed_won_lead_not_authoritative/i);
  assert.match(migration, /tenant_user\.tenant_id = p_source_tenant_id/i);
  assert.match(migration, /closed_won_onboarding_human_actor_not_source_tenant_owner/i);
});

test('one immutable handoff exists per source closed-won event', () => {
  assert.match(migration, /UNIQUE \(source_tenant_id, source_event_key\)/i);
  assert.match(migration, /UNIQUE \(closed_won_event_id\)/i);
  assert.match(migration, /trg_sales_closed_won_events_immutable/i);
  assert.match(migration, /trg_closed_won_onboarding_events_immutable/i);
  assert.match(migration, /closed_won_source_event_conflict/i);
  assert.match(migration, /pg_advisory_xact_lock/i);
});

test('handoff records acceptance, acknowledgment, SLA, retry, exception, and evidence state', () => {
  for (const column of [
    'acceptance_state',
    'acknowledgment_state',
    'sla_state',
    'retry_state',
    'evidence_state',
    'attempt_count',
    'accept_by',
    'acknowledge_by',
    'exception_code',
  ]) {
    assert.match(migration, new RegExp(`\\b${column}\\b`, 'i'));
  }
  assert.match(migration, /'accepted'/i);
  assert.match(migration, /p_evidence_type <> 'service_acceptance'/i);
  assert.match(migration, /OR p_actor_type = 'system'/i);
  assert.match(migration, /'acknowledged'/i);
  assert.match(migration, /'retry_scheduled'/i);
  assert.match(migration, /'retry_exhausted'/i);
  assert.match(migration, /'exception_raised'/i);
  assert.match(migration, /evidence_digest[\s\S]*\^\[a-f0-9\]\{64\}\$/i);
  assert.match(migration, /closed_won_onboarding_evidence_predates_handoff/i);
  assert.match(migration, /WHEN acknowledgment_state = 'acknowledged' THEN 'acknowledged'/i);
});

test('RPC is default-off, service-role-only, atomic, and has no external side effect', () => {
  assert.match(migration, /p_feature_gate_enabled boolean DEFAULT false/i);
  assert.match(migration, /closed_won_onboarding_handoff_disabled/i);
  assert.match(migration, /closed_won_onboarding_requires_service_role/i);
  assert.match(migration, /SECURITY DEFINER/i);
  assert.match(migration, /SET search_path = pg_catalog, public/i);
  assert.match(migration, /'outcome', 'replay'/i);
  assert.match(migration, /closed_won_onboarding_idempotency_conflict/i);
  assert.match(
    migration,
    /REVOKE EXECUTE ON FUNCTION public\.closed_won_onboarding_handoff_rpc[\s\S]*FROM PUBLIC, anon, authenticated/i
  );
  assert.match(
    migration,
    /GRANT EXECUTE ON FUNCTION public\.closed_won_onboarding_handoff_rpc[\s\S]*TO service_role/i
  );
  assert.doesNotMatch(migration, /\b(?:http|net|mail|sms|telnyx|twilio|stripe)_/i);
});

test('RLS and direct-write revocation keep the foundation fail-closed', () => {
  assert.match(migration, /ALTER TABLE public\.sales_closed_won_events ENABLE ROW LEVEL SECURITY/i);
  assert.match(migration, /ALTER TABLE public\.closed_won_onboarding_handoffs ENABLE ROW LEVEL SECURITY/i);
  assert.match(migration, /ALTER TABLE public\.closed_won_onboarding_events ENABLE ROW LEVEL SECURITY/i);
  assert.doesNotMatch(migration, /CREATE POLICY/i);
  assert.match(
    migration,
    /REVOKE INSERT, UPDATE, DELETE ON[\s\S]*FROM service_role/i
  );
});

test('rollback disables commands but preserves all handoff and evidence tables', () => {
  assert.match(rollback, /REVOKE EXECUTE ON FUNCTION public\.closed_won_onboarding_handoff_rpc/i);
  assert.match(rollback, /DROP FUNCTION IF EXISTS public\.closed_won_onboarding_handoff_rpc/i);
  assert.doesNotMatch(rollback, /\b(?:DROP TABLE|TRUNCATE|DELETE FROM)\b/i);
  assert.match(rollback, /evidence retained/i);
});
