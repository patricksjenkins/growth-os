'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const migration = fs.readFileSync(
  path.join(ROOT, 'db/migrations/079_billing_customer_attribution.sql'),
  'utf8',
);
const rollback = fs.readFileSync(
  path.join(ROOT, 'db/rollbacks/079_billing_customer_attribution_rollback.sql'),
  'utf8',
);
const databaseProof = fs.readFileSync(
  path.join(ROOT, 'test/sql/billing-attribution-negative.sql'),
  'utf8',
);

test('migration is additive and does not touch legacy finance totals or Stripe', () => {
  assert.doesNotMatch(migration, /ALTER\s+TABLE\s+public[.]finance_entries/i);
  assert.doesNotMatch(migration, /\b(UPDATE|DELETE\s+FROM|TRUNCATE)\s+public[.]finance_entries/i);
  assert.doesNotMatch(migration, /\bstripe[.](customers|invoices|charges|refunds|subscriptions)/i);
  assert.match(migration, /Existing finance_entries, totals, APIs/);
});

test('both ledgers use tenant foreign keys, RLS, and contained direct writes', () => {
  for (const table of ['billing_identity_mappings', 'finance_attribution_records']) {
    assert.match(migration, new RegExp(
      `CREATE TABLE IF NOT EXISTS public[.]${table}[\\s\\S]*?tenant_id\\s+uuid NOT NULL`,
    ));
    assert.match(migration, new RegExp(
      `ALTER TABLE public[.]${table} ENABLE ROW LEVEL SECURITY`,
    ));
  }
  assert.match(
    migration,
    /REVOKE INSERT, UPDATE, DELETE ON[\s\S]*billing_identity_mappings,[\s\S]*finance_attribution_records[\s\S]*FROM service_role/,
  );
  assert.doesNotMatch(migration, /CREATE POLICY[\s\S]*authenticated/i);
});

test('provider identities and source events cannot be rebound across tenants', () => {
  assert.match(
    migration,
    /UNIQUE \(provider, provider_account_ref, provider_object_type, provider_object_ref\)/,
  );
  assert.match(
    migration,
    /UNIQUE \(provider, provider_account_ref, source_event_type, source_event_id\)/,
  );
  assert.match(migration, /billing_identity_cross_tenant_or_customer_conflict/);
  assert.match(migration, /finance_attribution_source_event_conflict/);
  assert.match(
    migration,
    /source_event_id = p_source_event_id[\s\S]*v_existing[.]revenue_minor IS DISTINCT FROM p_revenue_minor/,
  );
});

test('identity chain validates tenant, customer, provider, account, and authority', () => {
  assert.match(migration, /finance_attribution_identity_chain_invalid/);
  assert.match(migration, /v_customer_mapping[.]customer_id IS DISTINCT FROM NEW[.]customer_id/);
  assert.match(migration, /v_tenant_mapping[.]provider IS DISTINCT FROM NEW[.]provider/);
  assert.match(
    migration,
    /v_customer_mapping[.]provider_account_ref IS DISTINCT FROM NEW[.]provider_account_ref/,
  );
  assert.match(migration, /v_customer_mapping[.]authority_state <> 'authoritative'/);
});

test('money uses exact minor-unit bigint with generated margin and fail-closed reconciliation', () => {
  assert.match(migration, /revenue_minor\s+bigint NOT NULL/);
  assert.match(migration, /cost_minor\s+bigint NOT NULL/);
  assert.match(
    migration,
    /margin_minor\s+bigint GENERATED ALWAYS AS \(revenue_minor - cost_minor\) STORED/,
  );
  assert.match(
    migration,
    /reconciliation_status IN \('pending', 'matched', 'exception'\)/,
  );
  assert.match(
    migration,
    /reconciliation_status = 'matched'[\s\S]*reconciled_revenue_minor = revenue_minor[\s\S]*reconciled_cost_minor = cost_minor/,
  );
});

test('evidence is immutable and RPCs are service-role-only and default-off', () => {
  assert.match(migration, /trg_billing_identity_mappings_immutable/);
  assert.match(migration, /trg_finance_attribution_records_immutable/);
  assert.match(migration, /billing_attribution_evidence_is_immutable/);
  assert.match(migration, /p_feature_gate_enabled boolean DEFAULT false/g);
  assert.match(migration, /billing_identity_registration_requires_service_role/);
  assert.match(migration, /finance_attribution_requires_service_role/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public[.]billing_identity_register_rpc[\s\S]*TO service_role/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public[.]finance_attribution_record_rpc[\s\S]*TO service_role/);
});

test('idempotency checks the fingerprint and the full persisted semantics', () => {
  assert.match(migration, /billing_identity_idempotency_conflict/);
  assert.match(migration, /finance_attribution_idempotency_conflict/);
  assert.match(
    migration,
    /v_existing[.]evidence_observed_at IS DISTINCT FROM p_evidence_observed_at/,
  );
  assert.match(
    migration,
    /v_existing[.]reconciled_cost_minor IS DISTINCT FROM p_reconciled_cost_minor/,
  );
});

test('rollback removes mutation paths but retains immutable evidence tables', () => {
  assert.match(rollback, /DROP FUNCTION IF EXISTS public[.]billing_identity_register_rpc/);
  assert.match(rollback, /DROP FUNCTION IF EXISTS public[.]finance_attribution_record_rpc/);
  assert.doesNotMatch(rollback, /DROP TABLE/i);
  assert.match(
    rollback,
    /REVOKE INSERT, UPDATE, DELETE ON[\s\S]*billing_identity_mappings,[\s\S]*finance_attribution_records[\s\S]*FROM service_role/,
  );
});

test('dedicated database proof covers roles, gates, replay, money, and tenant negatives', () => {
  assert.match(databaseProof, /SET LOCAL ROLE authenticated/);
  assert.match(databaseProof, /SET LOCAL ROLE service_role/);
  assert.match(databaseProof, /expected disabled billing identity write denial/);
  assert.match(databaseProof, /expected cross-tenant customer identity denial/);
  assert.match(databaseProof, /expected provider tenant identity rebind denial/);
  assert.match(databaseProof, /expected cross-tenant source event denial/);
  assert.match(databaseProof, /margin_minor'\)::bigint <> 9500/);
  assert.match(databaseProof, /replay_result->>'outcome' <> 'replay'/);
  assert.match(databaseProof, /expected immutable attribution mutation denial/);
});
