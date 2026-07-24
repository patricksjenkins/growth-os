'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  _internal: {
    canonicalRecoveryEnabled,
    recoveryEvidence,
    reconcileRecoveredIncident,
  },
} = require('../core/ops-guardian');
const { FGA_TENANT_ID } = require('../core/config');

const INCIDENT_ID = '60000000-0000-4000-8000-000000000001';
const WORK_ITEM_ID = '50000000-0000-4000-8000-000000000001';
const JOB_ID = '70000000-0000-4000-8000-000000000001';
const LEAD_ID = '80000000-0000-4000-8000-000000000001';
const ENABLED = Object.freeze({
  controlPlaneApi: true,
  decisionQueueWrites: true,
  incidentReconciliationWrites: true,
});
const ENABLED_ENV = Object.freeze({
  FGA_OS_CONTROL_PLANE_TENANT_ALLOWLIST: FGA_TENANT_ID,
  FGA_OS_DECISION_QUEUE_WRITE_TENANT_ALLOWLIST: FGA_TENANT_ID,
  FGA_OS_INCIDENT_RECONCILIATION_TENANT_ALLOWLIST: FGA_TENANT_ID,
});

function incident(overrides = {}) {
  return {
    id: INCIDENT_ID,
    tenant_id: FGA_TENANT_ID,
    agent_name: 'prospecting',
    issue_type: 'repeated_error',
    severity: 'red',
    status: 'remediating',
    detected_at: '2026-07-24T12:00:00.000Z',
    last_attempt_at: '2026-07-24T12:05:00.000Z',
    attention_queue_id: null,
    ...overrides,
  };
}

test('canonical recovery requires every write flag and exact tenant cohort', () => {
  assert.equal(canonicalRecoveryEnabled(ENABLED, ENABLED_ENV), true);
  assert.equal(canonicalRecoveryEnabled({
    ...ENABLED,
    incidentReconciliationWrites: false,
  }, ENABLED_ENV), false);
  assert.equal(canonicalRecoveryEnabled(ENABLED, {
    ...ENABLED_ENV,
    FGA_OS_INCIDENT_RECONCILIATION_TENANT_ALLOWLIST:
      '22222222-2222-4222-8222-222222222222',
  }), false);
});

test('zero-output recovery requires tenant output after incident detection', () => {
  const noOutput = recoveryEvidence(
    incident({ issue_type: 'zero_output' }),
    { last_success_job_id: JOB_ID, last_success_at: '2026-07-24T12:10:00.000Z' },
    { consecutiveZeroDays: 0, latest_output_id: LEAD_ID, latest_output_at: '2026-07-24T11:59:00.000Z' }
  );
  const resumed = recoveryEvidence(
    incident({ issue_type: 'zero_output' }),
    {},
    { consecutiveZeroDays: 0, latest_output_id: LEAD_ID, latest_output_at: '2026-07-24T12:10:00.000Z' }
  );

  assert.equal(noOutput, null);
  assert.deepEqual(resumed, {
    verification_method: 'output_observed',
    verification_reference: `lead:${LEAD_ID}`,
    observed_at: '2026-07-24T12:10:00.000Z',
  });
});

test('non-output recovery binds the exact successful job after the retry boundary', () => {
  assert.equal(recoveryEvidence(
    incident(),
    { last_success_job_id: JOB_ID, last_success_at: '2026-07-24T12:04:00.000Z' },
    {}
  ), null);
  assert.deepEqual(recoveryEvidence(
    incident(),
    { last_success_job_id: JOB_ID, last_success_at: '2026-07-24T12:10:00.000Z' },
    {}
  ), {
    verification_method: 'successful_run',
    verification_reference: `agent_job:${JOB_ID}`,
    observed_at: '2026-07-24T12:10:00.000Z',
  });
});

test('enabled guardian recovery uses only the transactional reconciliation RPC', async () => {
  const calls = [];
  const workItem = {
    id: WORK_ITEM_ID,
    tenant_id: FGA_TENANT_ID,
    source_id: INCIDENT_ID,
    authority_tier: 'system',
    revision: 1,
  };
  const db = {
    from(table) {
      assert.equal(table, 'work_items');
      return {
        select() { return this; },
        eq() { return this; },
        limit: async () => ({ data: [workItem], error: null }),
      };
    },
    async rpc(name, args) {
      calls.push({ name, args });
      assert.equal(name, 'incident_recovery_reconcile_rpc');
      return {
        data: {
          outcome: 'reconciled',
          incident: {
            id: INCIDENT_ID,
            tenant_id: FGA_TENANT_ID,
            status: 'recovered',
          },
          work_item: { id: WORK_ITEM_ID, status: 'verified' },
        },
        error: null,
      };
    },
  };

  const result = await reconcileRecoveredIncident(
    db,
    incident(),
    {
      verification_method: 'successful_run',
      verification_reference: `agent_job:${JOB_ID}`,
      observed_at: '2026-07-24T12:10:00.000Z',
    },
    ENABLED,
    ENABLED_ENV
  );

  assert.deepEqual(result, {
    mode: 'canonical',
    recovered: true,
    outcome: 'reconciled',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.p_tenant_id, FGA_TENANT_ID);
  assert.equal(calls[0].args.p_incident_id, INCIDENT_ID);
  assert.equal(calls[0].args.p_work_item_id, WORK_ITEM_ID);
});

test('disabled canonical recovery preserves the existing compatibility path', async () => {
  const db = {
    from() {
      throw new Error('disabled mode must not touch canonical tables');
    },
  };
  const result = await reconcileRecoveredIncident(
    db,
    incident(),
    {
      verification_method: 'successful_run',
      verification_reference: `agent_job:${JOB_ID}`,
      observed_at: '2026-07-24T12:10:00.000Z',
    },
    {},
    {}
  );
  assert.deepEqual(result, { mode: 'legacy', recovered: false });
});
