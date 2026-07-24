'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FinanceClosePlanningError,
  planMonthlyFinanceCloseCommand,
  verifyRequestFingerprint,
} = require('../../core/finance/monthly-close-planner');

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const CYCLE = '81111111-1111-4111-8111-111111111111';
const HUMAN = 'eeeeeeee-1111-4111-8111-111111111111';
const RECORD = '91111111-1111-4111-8111-111111111111';

function base(overrides = {}) {
  return {
    tenantId: TENANT_A,
    cycleId: CYCLE,
    periodStart: '2026-07-01',
    currency: 'usd',
    action: 'begin_close',
    expectedRevision: 0,
    idempotencyKey: 'finance-close:begin:2026-07',
    actorType: 'service',
    actorId: 'finance-close-worker',
    authorityTier: 'finance_operator',
    evidence: {
      source_type: 'period_open_attestation',
      source_id: 'synthetic-period-2026-07',
      observed_at: '2026-07-24T12:00:00Z',
    },
    ...overrides,
  };
}

test('plans a deterministic default-off command without I/O or totals', () => {
  const first = planMonthlyFinanceCloseCommand(base());
  const second = planMonthlyFinanceCloseCommand(base());

  assert.equal(first.rpc, 'finance_close_command_rpc');
  assert.equal(first.args.p_currency, 'USD');
  assert.equal(first.args.p_feature_gate_enabled, false);
  assert.equal(first.args.p_request_fingerprint, second.args.p_request_fingerprint);
  assert.equal(verifyRequestFingerprint(first), true);
  assert.deepEqual(first.safety, {
    executionMode: 'shadow',
    providerExportAllowed: false,
    productionPeriodLockAllowed: false,
    performsIo: false,
  });
  assert.equal('entries' in first.args, false);
});

test('exact tenant, period, and currency identity changes the fingerprint', () => {
  const baseline = planMonthlyFinanceCloseCommand(base());
  const tenantChanged = planMonthlyFinanceCloseCommand(base({ tenantId: TENANT_B }));
  const periodChanged = planMonthlyFinanceCloseCommand(base({
    periodStart: '2026-08-01',
  }));
  const currencyChanged = planMonthlyFinanceCloseCommand(base({ currency: 'EUR' }));

  assert.notEqual(
    baseline.args.p_request_fingerprint,
    tenantChanged.args.p_request_fingerprint,
  );
  assert.notEqual(
    baseline.args.p_request_fingerprint,
    periodChanged.args.p_request_fingerprint,
  );
  assert.notEqual(
    baseline.args.p_request_fingerprint,
    currencyChanged.args.p_request_fingerprint,
  );
});

test('period identity must be the first day of a real calendar month', () => {
  for (const value of ['2026-07-02', '2026-13-01', '07-01-2026']) {
    assert.throws(
      () => planMonthlyFinanceCloseCommand(base({ periodStart: value })),
      (error) => error instanceof FinanceClosePlanningError
        && error.code === 'PERIOD_START_INVALID',
    );
  }
});

test('reconciliation command requires distinct immutable record references', () => {
  const plan = planMonthlyFinanceCloseCommand(base({
    action: 'record_reconciliation',
    expectedRevision: 1,
    idempotencyKey: 'finance-close:reconcile:2026-07',
    reconciliationRecordIds: [RECORD],
    evidence: {
      source_type: 'finance_attribution_manifest',
      source_id: 'synthetic-manifest-2026-07',
      observed_at: '2026-07-24T12:01:00Z',
    },
  }));
  assert.deepEqual(plan.args.p_reconciliation_record_ids, [RECORD]);

  assert.throws(
    () => planMonthlyFinanceCloseCommand(base({
      action: 'record_reconciliation',
      expectedRevision: 1,
      reconciliationRecordIds: [],
    })),
    (error) => error.code === 'RECONCILIATION_IDS_REQUIRED',
  );
  assert.throws(
    () => planMonthlyFinanceCloseCommand(base({
      action: 'record_reconciliation',
      expectedRevision: 1,
      reconciliationRecordIds: [RECORD, RECORD],
    })),
    (error) => error.code === 'RECONCILIATION_IDS_DUPLICATE',
  );
});

test('exception planning includes ownership, SLA, and escalation identity', () => {
  const plan = planMonthlyFinanceCloseCommand(base({
    action: 'raise_exception',
    expectedRevision: 1,
    idempotencyKey: 'finance-close:exception:missing-bank',
    targetId: '82222222-2222-4222-8222-222222222222',
    assigneeId: HUMAN,
    dueAt: '2026-07-25T12:00:00Z',
    exceptionCode: 'bank_evidence_missing',
    evidence: {
      source_type: 'reconciliation_exception',
      source_id: 'synthetic-missing-bank',
      observed_at: '2026-07-24T12:00:00Z',
    },
  }));

  assert.equal(plan.args.p_assignee_id, HUMAN);
  assert.equal(plan.args.p_exception_code, 'bank_evidence_missing');
  assert.equal(plan.args.p_due_at, '2026-07-25T12:00:00.000Z');
});

test('signoff identity requires a human owner actor', () => {
  const valid = planMonthlyFinanceCloseCommand(base({
    action: 'sign_off',
    expectedRevision: 3,
    idempotencyKey: 'finance-close:signoff:2026-07',
    actorType: 'human',
    actorId: HUMAN,
    authorityTier: 'owner',
    evidence: {
      source_type: 'signoff_decision',
      source_id: 'synthetic-owner-signoff',
      observed_at: '2026-07-24T12:03:00Z',
    },
  }));
  assert.equal(valid.args.p_actor_id, HUMAN);

  assert.throws(
    () => planMonthlyFinanceCloseCommand(base({
      action: 'sign_off',
      expectedRevision: 3,
      actorType: 'service',
      actorId: 'finance-close-worker',
      authorityTier: 'owner',
    })),
    (error) => error.code === 'SERVICE_AUTHORITY_INVALID',
  );
});

test('review and task completion cannot be delegated to a system actor', () => {
  for (const action of ['reviewer_approve', 'complete_task']) {
    assert.throws(
      () => planMonthlyFinanceCloseCommand(base({
        action,
        expectedRevision: 2,
        targetId: action === 'complete_task'
          ? '85555555-1111-4111-8111-111111111111'
          : undefined,
      })),
      (error) => error.code === 'HUMAN_ACTION_REQUIRED',
    );
  }
});

test('raw ledgers, provider payloads, PII, and credentials are rejected', () => {
  for (const forbidden of [
    'entries',
    'financeEntries',
    'rawPayload',
    'providerToken',
    'customerEmail',
    'bankAccount',
  ]) {
    assert.throws(
      () => planMonthlyFinanceCloseCommand(base({ [forbidden]: 'forbidden' })),
      (error) => error.code === 'FORBIDDEN_SENSITIVE_INPUT',
    );
  }
});

test('non-reconciliation actions cannot smuggle reconciliation identities', () => {
  assert.throws(
    () => planMonthlyFinanceCloseCommand(base({
      reconciliationRecordIds: [RECORD],
    })),
    (error) => error.code === 'RECONCILIATION_IDS_FORBIDDEN',
  );
});
