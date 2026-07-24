'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  evaluateRuntimeGate,
  normalizeStripeHandoff,
  projectStripeClosedWonOnboarding,
} = require('../../core/operations/stripe-closed-won-onboarding');

const SOURCE_TENANT = '11111111-1111-4111-8111-111111111111';
const CLIENT_TENANT = '22222222-2222-4222-8222-222222222222';
const LEAD_ID = '33333333-3333-4333-8333-333333333333';
const CUSTOMER_ID = '44444444-4444-4444-8444-444444444444';
const WORKFLOW_ID = '55555555-5555-4555-8555-555555555555';
const HANDOFF_ID = '66666666-6666-4666-8666-666666666666';
const NOW = '2026-07-24T18:00:00.000Z';

function session(overrides = {}) {
  return {
    id: 'cs_test_safe_fixture',
    created: Math.floor(new Date('2026-07-24T17:00:00.000Z').getTime() / 1000),
    status: 'complete',
    payment_status: 'paid',
    customer_email: 'must-not-enter-canonical-contract@example.test',
    customer_details: { name: 'Must Not Enter Canonical Contract' },
    metadata: {
      source_tenant_id: SOURCE_TENANT,
      tenant_id: CLIENT_TENANT,
      lead_id: LEAD_ID,
      source_customer_id: CUSTOMER_ID,
    },
    ...overrides,
  };
}

function workflow(overrides = {}) {
  return {
    id: WORKFLOW_ID,
    tenant_id: CLIENT_TENANT,
    ...overrides,
  };
}

function allowedGate() {
  return { allowed: true, reasons: [] };
}

test('runtime gate requires three flags and exact source/client cohorts', () => {
  const denied = evaluateRuntimeGate({
    sourceTenantId: SOURCE_TENANT,
    clientTenantId: CLIENT_TENANT,
    flagSnapshot: {
      connectedWorkflowWrites: true,
      closedWonOnboardingWrites: true,
      strictWebhookVerification: true,
    },
    env: {
      FGA_OS_CLOSED_WON_SOURCE_TENANT_ALLOWLIST: SOURCE_TENANT,
      FGA_OS_CLOSED_WON_CLIENT_TENANT_ALLOWLIST: SOURCE_TENANT,
    },
  });
  const allowed = evaluateRuntimeGate({
    sourceTenantId: SOURCE_TENANT,
    clientTenantId: CLIENT_TENANT,
    flagSnapshot: {
      connectedWorkflowWrites: true,
      closedWonOnboardingWrites: true,
      strictWebhookVerification: true,
    },
    env: {
      FGA_OS_CLOSED_WON_SOURCE_TENANT_ALLOWLIST: SOURCE_TENANT,
      FGA_OS_CLOSED_WON_CLIENT_TENANT_ALLOWLIST: CLIENT_TENANT,
    },
  });

  assert.equal(denied.allowed, false);
  assert.ok(denied.reasons.includes('client_tenant_not_allowlisted'));
  assert.deepEqual(allowed, { allowed: true, reasons: [] });
});

test('normalization binds exact IDs and excludes Stripe customer PII', () => {
  const result = normalizeStripeHandoff({
    session: session(),
    workflow: workflow(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.handoff.source_tenant_id, SOURCE_TENANT);
  assert.equal(result.handoff.client_tenant_id, CLIENT_TENANT);
  assert.equal(result.handoff.lead_id, LEAD_ID);
  assert.equal(result.handoff.onboarding_workflow_id, WORKFLOW_ID);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('must-not-enter-canonical-contract'), false);
  assert.equal(serialized.includes('Must Not Enter Canonical Contract'), false);
  assert.match(result.handoff.evidence_digest, /^[a-f0-9]{64}$/);
  assert.match(result.handoff.source_event_key, /^stripe-checkout:[a-f0-9]{64}$/);
});

test('normalization fails closed on missing or mismatched identity', () => {
  const result = normalizeStripeHandoff({
    session: session({
      metadata: {
        source_tenant_id: SOURCE_TENANT,
        tenant_id: CLIENT_TENANT,
      },
    }),
    workflow: workflow({ tenant_id: SOURCE_TENANT }),
  });

  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('lead_id_missing_or_invalid'));
  assert.ok(result.errors.includes('onboarding_workflow_tenant_mismatch'));
});

test('authoritative checkout creates, service-accepts, and acknowledges once', async () => {
  const calls = [];
  const states = [
    ['created', 'pending_acceptance', 1, 'initiated'],
    ['applied', 'accepted', 2, 'accepted'],
    ['applied', 'acknowledged', 3, 'acknowledged'],
  ];
  const client = {
    async rpc(name, args) {
      assert.equal(name, 'closed_won_onboarding_handoff_rpc');
      calls.push(args);
      const [outcome, state, revision, eventType] = states[calls.length - 1];
      return {
        data: {
          outcome,
          handoff: {
            id: HANDOFF_ID,
            source_tenant_id: SOURCE_TENANT,
            client_tenant_id: CLIENT_TENANT,
            lead_id: LEAD_ID,
            onboarding_workflow_id: WORKFLOW_ID,
            state,
            revision,
          },
          event: {
            id: `${calls.length}7777777-7777-4777-8777-777777777777`,
            source_tenant_id: SOURCE_TENANT,
            handoff_id: HANDOFF_ID,
            event_type: eventType,
          },
        },
        error: null,
      };
    },
  };

  const result = await projectStripeClosedWonOnboarding({
    client,
    session: session(),
    workflow: workflow(),
    now: NOW,
    gate: allowedGate(),
  });

  assert.deepEqual(result, {
    mode: 'canonical',
    outcome: 'applied',
    handoff_id: HANDOFF_ID,
    state: 'acknowledged',
  });
  assert.deepEqual(calls.map(call => call.p_action), [
    'initiate',
    'accept',
    'acknowledge',
  ]);
  assert.equal(calls[1].p_actor_type, 'service');
  assert.equal(calls[1].p_evidence_type, 'service_acceptance');
  assert.equal(calls[2].p_onboarding_workflow_id, WORKFLOW_ID);
  assert.equal(JSON.stringify(calls).includes('must-not-enter-canonical-contract'), false);
});

test('a replay that is already acknowledged performs no duplicate transitions', async () => {
  let calls = 0;
  const client = {
    async rpc(_name, args) {
      calls += 1;
      assert.equal(args.p_action, 'initiate');
      return {
        data: {
          outcome: 'replay',
          handoff: {
            id: HANDOFF_ID,
            source_tenant_id: SOURCE_TENANT,
            client_tenant_id: CLIENT_TENANT,
            lead_id: LEAD_ID,
            onboarding_workflow_id: WORKFLOW_ID,
            state: 'acknowledged',
            revision: 3,
          },
          event: {
            id: '77777777-7777-4777-8777-777777777777',
            source_tenant_id: SOURCE_TENANT,
            handoff_id: HANDOFF_ID,
            event_type: 'initiated',
          },
        },
        error: null,
      };
    },
  };

  const result = await projectStripeClosedWonOnboarding({
    client,
    session: session(),
    workflow: workflow(),
    now: NOW,
    gate: allowedGate(),
  });

  assert.equal(result.state, 'acknowledged');
  assert.equal(calls, 1);
});

test('malformed service-role success fails closed', async () => {
  const client = {
    async rpc() {
      return { data: { outcome: 'created' }, error: null };
    },
  };

  await assert.rejects(
    projectStripeClosedWonOnboarding({
      client,
      session: session(),
      workflow: workflow(),
      now: NOW,
      gate: allowedGate(),
    }),
    /closed_won_onboarding_rpc_result_invalid/
  );
});
