'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const migration = fs.readFileSync(
  path.join(ROOT, 'db/migrations/091_marketing_brand_head_supervised.sql'),
  'utf8',
);
const rollback = fs.readFileSync(
  path.join(ROOT, 'db/rollbacks/091_marketing_brand_head_supervised_rollback.sql'),
  'utf8',
);
const proof = fs.readFileSync(
  path.join(ROOT, 'test/sql/marketing-brand-head-negative.sql'),
  'utf8',
);
const concurrencyProof = fs.readFileSync(
  path.join(ROOT, 'test/sql/marketing-brand-head-concurrency.sql'),
  'utf8',
);

test('written mission and marketing KPI contract are mandatory', () => {
  assert.match(migration, /mission\s+text NOT NULL/);
  for (const kpi of [
    'content_quality_acceptance_rate',
    'delivery_receipt_completeness_rate',
    'audience_evidence_completeness_rate',
    'reply_observation_rate',
    'conversion_observation_rate',
    'brand_compliance_exception_sla_hours',
    'cohort_size_limit',
  ]) assert.match(migration, new RegExp(`'${kpi}'`));
});

test('all production-bound Marketing Head authority is structurally false', () => {
  for (const field of [
    'production_write_authority',
    'content_publication_authority',
    'provider_dispatch_authority',
    'customer_contact_authority',
    'paid_advertising_authority',
    'spend_authority',
    'pricing_authority',
    'legal_policy_authority',
  ]) {
    assert.match(
      migration,
      new RegExp(`${field}[\\s\\S]*CHECK \\(${field} = false\\)`),
    );
  }
  assert.doesNotMatch(
    migration,
    /\b(fetch|axios|stripe[.]|telnyx[.]|resend[.]|buffer[.])\b/i,
  );
});

test('accepted reports reference canonical 082 content evidence', () => {
  for (const source of [
    'content_artifact_versions',
    'content_quality_evaluations',
    'content_delivery_receipts',
  ]) assert.match(migration, new RegExp(`REFERENCES public[.]${source}`));
  assert.match(migration, /receipt[.]delivery_state = 'delivered'/);
  assert.match(migration, /quality[.]quality_state = 'accepted'/);
  assert.match(
    migration,
    /count\(DISTINCT quality[.]content_version_id\) FILTER/,
  );
  for (const section of [
    'content_quality',
    'delivery_receipts',
    'audience',
    'replies',
    'conversions',
    'brand_compliance_exceptions',
    'cohort',
  ]) assert.match(migration, new RegExp(`'${section}'`));
});

test('completion cannot imply delivery quality or business effect', () => {
  assert.match(migration, /content_completion_state[\s\S]*quality_state[\s\S]*delivery_state/);
  assert.doesNotMatch(
    migration,
    /content_completion_state\s*=\s*'completed'[\s\S]{0,160}(accepted|delivered|observed_association)/,
  );
  assert.match(proof, /completed content incorrectly implied downstream truth/);
});

test('observations are bounded descriptive associations, never causality', () => {
  assert.match(migration, /causal_claim[\s\S]*CHECK \(causal_claim = false\)/);
  assert.match(migration, /attribution_model = 'descriptive_association_only'/);
  assert.match(migration, /cohort_size <= cohort_limit/);
  assert.match(migration, /v_cohort > v_control[.]max_observation_cohort_size/);
});

test('durable lifecycle covers assignment through verified outcome', () => {
  for (const value of [
    'goal', 'work', 'decision', 'exception', 'assigned', 'accepted',
    'escalated', 'completed', 'verified_achieved', 'verified_not_achieved',
  ]) assert.match(migration, new RegExp(`'${value}'`));
  assert.match(migration, /marketing_brand_work_acceptance_invalid/);
  assert.match(migration, /marketing_brand_work_escalation_invalid/);
  assert.match(migration, /marketing_brand_work_completion_invalid/);
  assert.match(migration, /marketing_brand_outcome_contract_invalid/);
  assert.match(migration, /marketing_brand_goal_completion_invalid/);
  assert.match(migration, /marketing_brand_decision_invalid/);
  assert.match(migration, /marketing_brand_exception_resolution_invalid/);
  assert.match(proof, /Marketing Head ordinary case lifecycle did not terminate/);
});

test('work is assigned to the stored registered Head actor', () => {
  assert.match(migration, /assignee_actor_id\s+text/);
  assert.match(
    migration,
    /v_case[.]assignee_actor_id IS DISTINCT FROM p_actor_id/g,
  );
  assert.doesNotMatch(
    proof,
    /"assignee_id":"aaaaaaaa-1111-4111-8111-111111111111"/,
  );
});

test('report case event and evidence metadata are minimized', () => {
  for (const helper of [
    'marketing_brand_json_has_forbidden_key',
    'marketing_brand_evidence_is_minimized',
    'marketing_brand_report_metadata_is_minimized',
    'marketing_brand_case_contract_is_minimized',
    'marketing_brand_payload_is_minimized',
  ]) assert.match(migration, new RegExp(helper));
  assert.match(
    migration,
    /regexp_replace\(lower\(v_key\), '\[\^a-z0-9\]', '', 'g'\)/,
  );
  assert.match(proof, /"Customer-Email":"forbidden"/);
});

test('authority idempotency RLS immutable evidence and kill switch fail closed', () => {
  for (const phrase of [
    'marketing_brand_registered_head_required',
    'marketing_brand_idempotency_conflict',
    'marketing_brand_evidence_is_immutable',
    'marketing_brand_kill_switch_is_one_way',
    'kill_switch_reason_digest',
  ]) assert.match(migration, new RegExp(phrase));
  assert.match(
    migration,
    /REVOKE INSERT, UPDATE, DELETE ON[\s\S]*marketing_brand_head_events[\s\S]*FROM PUBLIC, anon, authenticated, service_role/,
  );
});

test('rollback preserves evidence and removes mutation paths', () => {
  assert.match(rollback, /kill_switch_engaged = true/);
  assert.match(
    rollback,
    /DROP FUNCTION IF EXISTS public[.]marketing_brand_head_command_rpc/,
  );
  assert.doesNotMatch(rollback.replace(/--.*$/gm, ''), /DROP TABLE/i);
});

test('tenant control lock serializes commands before disable', () => {
  assert.match(
    migration,
    /FROM public[.]marketing_brand_head_controls control[\s\S]{0,160}FOR SHARE/,
  );
  assert.match(
    concurrencyProof,
    /expected kill to wait behind in-flight Marketing Head command/,
  );
  assert.match(
    concurrencyProof,
    /command after concurrent Marketing Head kill denial/,
  );
});

test('PostgreSQL proof covers tenant authority false green and containment', () => {
  for (const phrase of [
    'expected authenticated Marketing Head RPC denial',
    'expected unregistered Marketing Head denial',
    'expected cross-tenant artifact evidence denial',
    'expected direct Marketing Head service write denial',
    'expected publication-bound Marketing Head payload denial',
    'expected immutable Marketing Head evidence denial',
    'expected engaged Marketing Head kill switch denial',
    'tenant A saw tenant B Marketing Head evidence',
  ]) assert.match(proof, new RegExp(phrase));
});
