'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BillingAttributionError,
  planBillingIdentityRegistration,
  planFinanceAttribution,
} = require('../../core/finance/billing-attribution');

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const CUSTOMER_ID = '22222222-2222-4222-8222-222222222222';
const TENANT_MAPPING_ID = '33333333-3333-4333-8333-333333333333';
const CUSTOMER_MAPPING_ID = '44444444-4444-4444-8444-444444444444';
const DIGEST = 'a'.repeat(64);

function mappingInput(overrides = {}) {
  return {
    tenantId: TENANT_ID,
    scopeType: 'customer',
    customerId: CUSTOMER_ID,
    provider: 'stripe',
    providerAccountRef: 'acct_platform_01',
    providerObjectType: 'customer',
    providerObjectRef: 'cus_shadow_01',
    evidenceType: 'verified_webhook',
    evidenceId: 'evt_shadow_identity_01',
    evidenceDigest: DIGEST,
    evidenceObservedAt: '2026-07-24T12:00:00.000Z',
    actorType: 'service',
    actorId: 'billing-shadow-adapter',
    idempotencyKey: 'identity:evt_shadow_identity_01',
    ...overrides,
  };
}

function attributionInput(overrides = {}) {
  return {
    tenantId: TENANT_ID,
    customerId: CUSTOMER_ID,
    tenantMappingId: TENANT_MAPPING_ID,
    customerMappingId: CUSTOMER_MAPPING_ID,
    provider: 'stripe',
    providerAccountRef: 'acct_platform_01',
    sourceEventType: 'invoice_paid',
    sourceEventId: 'evt_shadow_paid_01',
    occurredOn: '2026-07-24',
    currency: 'usd',
    revenueMinor: 12000,
    costMinor: 2500,
    reconciliationStatus: 'matched',
    reconciledRevenueMinor: 12000,
    reconciledCostMinor: 2500,
    evidenceDigest: DIGEST,
    evidenceObservedAt: '2026-07-24T12:00:00.000Z',
    actorType: 'system',
    actorId: null,
    idempotencyKey: 'attribution:evt_shadow_paid_01',
    ...overrides,
  };
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => (
    error instanceof BillingAttributionError && error.code === code
  ));
}

test('identity planner returns a deterministic disabled RPC command', () => {
  const first = planBillingIdentityRegistration(mappingInput());
  const second = planBillingIdentityRegistration(mappingInput());

  assert.equal(first.rpc, 'billing_identity_register_rpc');
  assert.equal(first.args.p_feature_gate_enabled, false);
  assert.equal(first.args.p_customer_id, CUSTOMER_ID);
  assert.match(first.args.p_request_fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(first, second);
});

test('tenant identity cannot claim a customer or customer provider object', () => {
  expectCode(
    () => planBillingIdentityRegistration(mappingInput({
      scopeType: 'tenant',
      providerObjectType: 'tenant',
    })),
    'IDENTITY_CUSTOMER_SCOPE_MISMATCH',
  );
  expectCode(
    () => planBillingIdentityRegistration(mappingInput({
      scopeType: 'tenant',
      customerId: null,
      providerObjectType: 'customer',
    })),
    'IDENTITY_OBJECT_SCOPE_MISMATCH',
  );
});

test('identity planner rejects provider references containing whitespace or PII shape', () => {
  expectCode(
    () => planBillingIdentityRegistration(mappingInput({
      providerObjectRef: 'customer@example.com',
    })),
    'PROVIDER_OBJECT_REF_INVALID',
  );
  expectCode(
    () => planBillingIdentityRegistration(mappingInput({
      providerObjectRef: 'cus shadow',
    })),
    'PROVIDER_OBJECT_REF_INVALID',
  );
});

test('identity planner permits a system actor only without an actor id', () => {
  const command = planBillingIdentityRegistration(mappingInput({
    actorType: 'system',
    actorId: null,
  }));
  assert.equal(command.args.p_actor_id, null);

  expectCode(
    () => planBillingIdentityRegistration(mappingInput({
      actorType: 'human',
      actorId: CUSTOMER_ID,
    })),
    'ACTOR_TYPE_INVALID',
  );
  expectCode(
    () => planBillingIdentityRegistration(mappingInput({
      actorType: 'system',
      actorId: 'claimed-system',
    })),
    'SYSTEM_ACTOR_ID_FORBIDDEN',
  );
});

test('planner rejects raw payloads and common sensitive customer fields', () => {
  expectCode(
    () => planBillingIdentityRegistration(mappingInput({
      rawPayload: { customer_email: 'do-not-ingest@example.invalid' },
    })),
    'FORBIDDEN_SENSITIVE_INPUT',
  );
  expectCode(
    () => planFinanceAttribution(attributionInput({
      paymentMethod: 'do-not-ingest',
    })),
    'FORBIDDEN_SENSITIVE_INPUT',
  );
});

test('finance planner preserves signed exact minor units and normalizes currency', () => {
  const command = planFinanceAttribution(attributionInput({
    revenueMinor: -1200,
    costMinor: -200,
    reconciledRevenueMinor: -1200,
    reconciledCostMinor: -200,
  }));

  assert.equal(command.rpc, 'finance_attribution_record_rpc');
  assert.equal(command.args.p_revenue_minor, -1200);
  assert.equal(command.args.p_cost_minor, -200);
  assert.equal(command.args.p_currency, 'USD');
  assert.equal(command.args.p_feature_gate_enabled, false);
});

test('finance planner rejects decimal and unsafe minor-unit amounts', () => {
  expectCode(
    () => planFinanceAttribution(attributionInput({ revenueMinor: '12.34' })),
    'ATTRIBUTION_AMOUNT_INVALID',
  );
  expectCode(
    () => planFinanceAttribution(attributionInput({
      revenueMinor: Number.MAX_SAFE_INTEGER + 1,
    })),
    'ATTRIBUTION_AMOUNT_INVALID',
  );
  expectCode(
    () => planFinanceAttribution(attributionInput({
      revenueMinor: Number.MAX_SAFE_INTEGER,
      costMinor: Number.MIN_SAFE_INTEGER,
      reconciledRevenueMinor: Number.MAX_SAFE_INTEGER,
      reconciledCostMinor: Number.MIN_SAFE_INTEGER,
    })),
    'ATTRIBUTION_MARGIN_OUT_OF_RANGE',
  );
});

test('matched reconciliation requires exact revenue and cost equality', () => {
  expectCode(
    () => planFinanceAttribution(attributionInput({ reconciledCostMinor: 2499 })),
    'MATCHED_RECONCILIATION_DIFFERS',
  );
});

test('pending reconciliation cannot claim authoritative totals', () => {
  expectCode(
    () => planFinanceAttribution(attributionInput({
      reconciliationStatus: 'pending',
    })),
    'PENDING_RECONCILIATION_HAS_TOTALS',
  );

  const pending = planFinanceAttribution(attributionInput({
    reconciliationStatus: 'pending',
    reconciledRevenueMinor: null,
    reconciledCostMinor: null,
  }));
  assert.equal(pending.args.p_reconciliation_status, 'pending');
});

test('exception reconciliation requires a known non-zero difference', () => {
  expectCode(
    () => planFinanceAttribution(attributionInput({
      reconciliationStatus: 'exception',
    })),
    'RECONCILIATION_EXCEPTION_UNPROVEN',
  );
  const exception = planFinanceAttribution(attributionInput({
    reconciliationStatus: 'exception',
    reconciledCostMinor: 2600,
  }));
  assert.equal(exception.args.p_reconciled_cost_minor, 2600);
});

test('planner rejects impossible calendar dates and malformed identity', () => {
  expectCode(
    () => planFinanceAttribution(attributionInput({ occurredOn: '2026-02-31' })),
    'OCCURRED_ON_INVALID',
  );
  expectCode(
    () => planFinanceAttribution(attributionInput({ customerId: TENANT_ID.slice(0, -1) })),
    'CUSTOMER_ID_INVALID',
  );
});

test('a semantic change changes the request fingerprint', () => {
  const base = planFinanceAttribution(attributionInput());
  const changed = planFinanceAttribution(attributionInput({
    revenueMinor: 12001,
    reconciledRevenueMinor: 12001,
  }));
  assert.notEqual(
    base.args.p_request_fingerprint,
    changed.args.p_request_fingerprint,
  );
});
