'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LeadActionPlanningError,
  planLeadActionCommand,
  verifyRequestFingerprint,
} = require('../../core/revenue/lead-action-planner');

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const LEAD_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const ACTION_A = '84111111-1111-4111-8111-111111111111';
const HUMAN_A = 'eeeeeeee-1111-4111-8111-111111111111';

function assignment(overrides = {}) {
  return {
    tenantId: TENANT_A,
    leadId: LEAD_A,
    leadActionId: ACTION_A,
    actionType: 'proposal_follow_up',
    command: 'assign',
    expectedRevision: 0,
    idempotencyKey: 'lead-action:assign:synthetic-a',
    actorType: 'service',
    actorId: 'revenue-shadow-worker',
    authorityTier: 'sales_operator',
    assigneeType: 'human',
    assigneeId: HUMAN_A,
    dueAt: '2026-07-25T12:00:00Z',
    outcomeDueAt: '2026-08-08T12:00:00Z',
    cohortKey: 'proposal_v1',
    assignmentSourceType: 'sales_pipeline_rule',
    assignmentSourceId: 'synthetic-rule-v1',
    evidence: {
      source_type: 'assignment_decision',
      source_id: 'synthetic-assignment-a',
      observed_at: '2026-07-24T12:00:00Z',
    },
    ...overrides,
  };
}

test('plans a deterministic default-off evidence command without I/O', () => {
  const first = planLeadActionCommand(assignment());
  const second = planLeadActionCommand(assignment());

  assert.equal(first.rpc, 'lead_action_command_rpc');
  assert.equal(first.args.p_feature_gate_enabled, false);
  assert.equal(first.args.p_request_fingerprint, second.args.p_request_fingerprint);
  assert.equal(verifyRequestFingerprint(first), true);
  assert.deepEqual(first.safety, {
    executionMode: 'shadow',
    outreachAllowed: false,
    providerDispatchAllowed: false,
    causalClaimAllowed: false,
    performsIo: false,
  });
  assert.equal('message' in first.args, false);
  assert.equal('provider' in first.args, false);
});

test('exact tenant, lead, action, and action-type identity affects fingerprint', () => {
  const baseline = planLeadActionCommand(assignment());
  const variants = [
    assignment({ tenantId: TENANT_B }),
    assignment({ leadId: 'bbbbbbbb-2222-4222-8222-222222222222' }),
    assignment({ leadActionId: '84222222-2222-4222-8222-222222222222' }),
    assignment({ actionType: 'qualification' }),
  ].map(planLeadActionCommand);

  for (const variant of variants) {
    assert.notEqual(
      baseline.args.p_request_fingerprint,
      variant.args.p_request_fingerprint,
    );
  }
});

test('assignment carries durable owner, SLA, cohort, and source contracts', () => {
  const plan = planLeadActionCommand(assignment({ featureGateEnabled: true }));

  assert.equal(plan.args.p_assignee_id, HUMAN_A);
  assert.equal(plan.args.p_due_at, '2026-07-25T12:00:00.000Z');
  assert.equal(plan.args.p_outcome_due_at, '2026-08-08T12:00:00.000Z');
  assert.equal(plan.args.p_cohort_key, 'proposal_v1');
  assert.equal(plan.args.p_assignment_source_type, 'sales_pipeline_rule');
  assert.equal(plan.args.p_feature_gate_enabled, true);
});

test('outcome window cannot precede the action SLA', () => {
  assert.throws(
    () => planLeadActionCommand(assignment({
      outcomeDueAt: '2026-07-24T12:00:00Z',
    })),
    (error) => error instanceof LeadActionPlanningError
      && error.code === 'OUTCOME_DUE_AT_INVALID',
  );
});

test('completion and escalation receipts require structured dispositions', () => {
  const completion = planLeadActionCommand(assignment({
    command: 'complete',
    expectedRevision: 2,
    idempotencyKey: 'lead-action:complete:synthetic-a',
    actorType: 'human',
    actorId: HUMAN_A,
    authorityTier: 'sales_operator',
    completionDisposition: 'performed',
    evidence: {
      source_type: 'completion_attestation',
      source_id: 'synthetic-completion-a',
      observed_at: '2026-07-25T11:00:00Z',
    },
  }));
  assert.equal(completion.args.p_completion_disposition, 'performed');

  const escalation = planLeadActionCommand(assignment({
    command: 'escalate',
    expectedRevision: 1,
    idempotencyKey: 'lead-action:escalate:synthetic-a',
    actorType: 'human',
    actorId: HUMAN_A,
    authorityTier: 'owner',
    escalationCode: 'manual_priority_review',
    evidence: {
      source_type: 'manual_escalation',
      source_id: 'synthetic-escalation-a',
      observed_at: '2026-07-24T13:00:00Z',
    },
  }));
  assert.equal(escalation.args.p_escalation_code, 'manual_priority_review');
});

test('known outcomes require observed association evidence', () => {
  const plan = planLeadActionCommand(assignment({
    command: 'record_outcome',
    expectedRevision: 3,
    idempotencyKey: 'lead-action:outcome:synthetic-a',
    outcomeState: 'converted',
    attributionState: 'observed',
    outcomeSourceType: 'closed_won_transition',
    outcomeSourceId: 'synthetic-closed-won-a',
    evidence: {
      source_type: 'lead_outcome_observation',
      source_id: 'synthetic-observation-a',
      observed_at: '2026-07-26T12:00:00Z',
    },
  }));

  assert.equal(plan.args.p_outcome_state, 'converted');
  assert.equal(plan.args.p_attribution_state, 'observed');
  assert.equal(plan.safety.causalClaimAllowed, false);

  assert.throws(
    () => planLeadActionCommand(assignment({
      command: 'record_outcome',
      expectedRevision: 3,
      outcomeState: 'converted',
      attributionState: 'unknown',
    })),
    (error) => error.code === 'OBSERVED_ATTRIBUTION_REQUIRED',
  );
});

test('unknown outcomes remain explicit and cannot smuggle observed sources', () => {
  const unknown = planLeadActionCommand(assignment({
    command: 'record_outcome',
    expectedRevision: 3,
    idempotencyKey: 'lead-action:outcome-unknown:synthetic-a',
    outcomeState: 'unknown',
    attributionState: 'unknown',
    evidence: {
      source_type: 'outcome_window_expired',
      source_id: 'synthetic-window-a',
      observed_at: '2026-08-08T12:01:00Z',
    },
  }));
  assert.equal(unknown.args.p_outcome_source_type, null);
  assert.equal(unknown.args.p_outcome_source_id, null);

  assert.throws(
    () => planLeadActionCommand(assignment({
      command: 'record_outcome',
      expectedRevision: 3,
      outcomeState: 'unknown',
      attributionState: 'unknown',
      outcomeSourceType: 'guessed_conversion',
    })),
    (error) => error.code === 'UNKNOWN_ATTRIBUTION_INVALID',
  );
});

test('PII, provider dispatch, outreach, and causal claims are rejected recursively', () => {
  for (const forbidden of [
    { customerEmail: 'hidden@example.test' },
    { providerPayload: { external: true } },
    { send: true },
    { evidence: {
      source_type: 'assignment_decision',
      source_id: 'synthetic-assignment-a',
      observed_at: '2026-07-24T12:00:00Z',
      causalEffect: 0.3,
    } },
  ]) {
    assert.throws(
      () => planLeadActionCommand(assignment(forbidden)),
      (error) => error.code === 'FORBIDDEN_INPUT',
    );
  }
});

