'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const migration = fs.readFileSync(
  path.join(root, 'db', 'migrations', '074_incident_recovery_reconciliation.sql'),
  'utf8'
);
const rollback = fs.readFileSync(
  path.join(root, 'db', 'rollbacks', '074_incident_recovery_reconciliation_rollback.sql'),
  'utf8'
);

test('migration is additive and preserves incident and attention history', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.incident_work_item_links/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.incident_reconciliation_events/i);
  assert.doesNotMatch(migration, /\b(?:DROP|TRUNCATE|DELETE)\s+TABLE\b/i);
  assert.doesNotMatch(migration, /\bDELETE\s+FROM\s+public\.(?:attention_queue|ops_incidents)/i);
  assert.doesNotMatch(migration, /ALTER TABLE public\.(?:attention_queue|ops_incidents)/i);
  assert.match(migration, /resolution = 'superseded_by_canonical_incident_recovery'/i);
  assert.match(migration, /resolved_at IS NULL/i);
});

test('all relationships and mutations are tenant-bound under row locks', () => {
  assert.match(migration, /incident\.id = NEW\.incident_id[\s\S]*incident\.tenant_id = NEW\.tenant_id/i);
  assert.match(migration, /attention\.id = NEW\.attention_queue_id[\s\S]*attention\.tenant_id = NEW\.tenant_id/i);
  assert.match(migration, /FOREIGN KEY \(work_item_id, tenant_id\)/i);
  assert.match(migration, /incident\.id = p_incident_id[\s\S]*incident\.tenant_id = p_tenant_id[\s\S]*FOR UPDATE/i);
  assert.match(migration, /work\.id = p_work_item_id[\s\S]*work\.tenant_id = p_tenant_id[\s\S]*FOR UPDATE/i);
  assert.match(migration, /attention\.id = v_attention_id[\s\S]*attention\.tenant_id = p_tenant_id[\s\S]*FOR UPDATE/i);
  assert.match(migration, /work_item_incident_source_mismatch/i);
  assert.match(migration, /incident_attention_link_conflict/i);
  assert.match(migration, /recovery_evidence_predates_incident/i);
  assert.match(migration, /job\.tenant_id = p_tenant_id/i);
  assert.match(migration, /job\.agent_name = v_incident\.agent_name/i);
  assert.match(migration, /job\.status IN \('completed', 'success'\)/i);
  assert.match(migration, /lead\.tenant_id = p_tenant_id/i);
  assert.match(migration, /lead\.lead_source = 'prospecting_agent'/i);
  assert.match(migration, /output_incident_requires_output_evidence/i);
  assert.match(migration, /lead_output_evidence_not_valid_for_incident/i);
  assert.match(migration, /recovery_evidence_not_found_for_tenant/i);
  assert.match(migration, /recovery_observed_at_not_authoritative/i);
});

test('one transaction recovers incident, verifies work, supersedes attention, and appends evidence', () => {
  assert.match(migration, /UPDATE public\.work_items[\s\S]*status = 'verified'/i);
  assert.match(migration, /UPDATE public\.ops_incidents[\s\S]*status = 'recovered'/i);
  assert.match(migration, /UPDATE public\.attention_queue[\s\S]*resolved_at = now\(\)/i);
  assert.match(migration, /INSERT INTO public\.work_item_events/i);
  assert.match(migration, /INSERT INTO public\.incident_reconciliation_events/i);
  assert.match(migration, /verification_state = 'passed'/i);
  assert.match(
    migration,
    /verification_reference[\s\S]*~ '\^\[a-z\]\[a-z0-9_-\]/i
  );
  assert.match(migration, /request_fingerprint\s+~ '\^\[a-f0-9\]\{64\}\$'/i);
  assert.doesNotMatch(migration, /^\s*(?:COMMIT|ROLLBACK)\s*;/im);
});

test('RPC is default-off, service-role-only, authoritative, and retry-safe', () => {
  assert.match(migration, /p_feature_gate_enabled boolean DEFAULT false/i);
  assert.match(migration, /incident_reconciliation_writes_disabled/i);
  assert.match(migration, /incident_reconciliation_requires_service_role/i);
  assert.match(migration, /pg_advisory_xact_lock/i);
  assert.match(migration, /'outcome', 'replay'/i);
  assert.match(migration, /incident_reconciliation_idempotency_conflict/i);
  assert.match(migration, /incident_reconciliation_incomplete_conflict/i);
  assert.match(migration, /v_work\.revision IS DISTINCT FROM p_expected_work_item_revision/i);
  assert.match(migration, /v_actor_rank < v_required_rank/i);
  assert.match(
    migration,
    /REVOKE EXECUTE ON FUNCTION public\.incident_recovery_reconcile_rpc[\s\S]*FROM PUBLIC, anon, authenticated/i
  );
  assert.match(
    migration,
    /GRANT EXECUTE ON FUNCTION public\.incident_recovery_reconcile_rpc[\s\S]*TO service_role/i
  );
});

test('evidence and links are immutable and not exposed to tenant sessions', () => {
  assert.match(migration, /trg_incident_work_item_links_immutable/i);
  assert.match(migration, /trg_incident_reconciliation_events_immutable/i);
  assert.match(migration, /ALTER TABLE public\.incident_work_item_links ENABLE ROW LEVEL SECURITY/i);
  assert.match(migration, /ALTER TABLE public\.incident_reconciliation_events ENABLE ROW LEVEL SECURITY/i);
  assert.doesNotMatch(migration, /CREATE POLICY/i);
  assert.match(
    migration,
    /REVOKE ALL ON[\s\S]*incident_work_item_links[\s\S]*incident_reconciliation_events[\s\S]*FROM PUBLIC, anon, authenticated/i
  );
  assert.match(
    migration,
    /REVOKE INSERT, UPDATE, DELETE ON[\s\S]*FROM service_role/i
  );
});

test('rollback removes only the isolated foundation and refuses evidence loss', () => {
  assert.match(rollback, /DROP FUNCTION IF EXISTS public\.incident_recovery_reconcile_rpc/i);
  assert.match(rollback, /incident reconciliation evidence exists/i);
  assert.ok(
    rollback.indexOf('incident reconciliation evidence exists') <
      rollback.indexOf('DROP FUNCTION IF EXISTS public.incident_recovery_reconcile_rpc'),
    'evidence guard must run before any rollback mutation'
  );
  assert.match(rollback, /DROP TABLE IF EXISTS public\.incident_reconciliation_events/i);
  assert.match(rollback, /DROP TABLE IF EXISTS public\.incident_work_item_links/i);
  assert.doesNotMatch(rollback, /DROP TABLE IF EXISTS public\.(?:attention_queue|ops_incidents|work_items)/i);
  assert.doesNotMatch(rollback, /\bDELETE\s+FROM\b/i);
});
