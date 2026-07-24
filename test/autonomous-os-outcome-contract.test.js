'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildOutcomeEnvelope } = require('../core/autonomous-os/outcome-contract');
const { flags } = require('../core/autonomous-os/feature-flags');

test('a non-throwing success:false result is not reported as successful', () => {
  const outcome = buildOutcomeEnvelope({
    result: { success: false, reason: 'missing configuration' },
    durationMs: 15,
  });

  assert.equal(outcome.execution_state, 'completed');
  assert.equal(outcome.result_state, 'failed');
  assert.equal(outcome.business_outcome_state, 'unverified');
  assert.equal(outcome.reason_code, 'handler_returned_failure');
});

test('a legacy completed result does not pretend output or business value', () => {
  const outcome = buildOutcomeEnvelope({ result: { success: true, processed: 12 } });

  assert.equal(outcome.result_state, 'succeeded');
  assert.equal(outcome.output_state, 'unknown');
  assert.equal(outcome.quality_state, 'unverified');
  assert.equal(outcome.business_outcome_state, 'unverified');
});

test('an explicit contract preserves separate output, quality, delivery, and outcome states', () => {
  const outcome = buildOutcomeEnvelope({
    result: {
      success: true,
      outcome_contract: {
        result_state: 'succeeded',
        output_state: 'produced',
        quality_state: 'accepted',
        delivery_state: 'delivered',
        business_outcome_state: 'achieved',
        reason_code: 'qualified_reply_recorded',
        evidence: { conversation_id: 'safe-reference', count: 1 },
      },
    },
  });

  assert.equal(outcome.contract_source, 'declared');
  assert.equal(outcome.output_state, 'produced');
  assert.equal(outcome.quality_state, 'accepted');
  assert.equal(outcome.delivery_state, 'delivered');
  assert.equal(outcome.business_outcome_state, 'achieved');
  assert.deepEqual(outcome.evidence, { conversation_id: 'safe-reference', count: 1 });
});

test('a thrown handler is an execution and result failure', () => {
  const outcome = buildOutcomeEnvelope({ error: new TypeError('private detail') });

  assert.equal(outcome.execution_state, 'failed');
  assert.equal(outcome.result_state, 'failed');
  assert.equal(outcome.reason_code, 'handler_threw');
  assert.deepEqual(outcome.evidence, { error_name: 'TypeError' });
});

test('structured fail-closed errors retain safe reason and scalar evidence', () => {
  const error = new Error('configuration failed');
  error.name = 'ProspectingConfigurationError';
  error.reasonCode = 'prospecting_configuration_invalid';
  error.evidence = {
    missing_count: 2,
    invalid_count: 1,
    nested_value: { must_not_copy: true },
  };
  const outcome = buildOutcomeEnvelope({ error });

  assert.equal(outcome.result_state, 'failed');
  assert.equal(outcome.reason_code, 'prospecting_configuration_invalid');
  assert.equal(outcome.evidence.error_name, 'ProspectingConfigurationError');
  assert.equal(outcome.evidence.missing_count, 2);
  assert.equal(outcome.evidence.invalid_count, 1);
  assert.equal(outcome.evidence.nested_value, undefined);
});

test('all authority flags default off while additive outcome observability defaults on', () => {
  const names = [
    'FGA_OS_OUTCOME_OBSERVABILITY_ENABLED',
    'FGA_OS_AUTHZ_APP_METADATA_ENFORCE',
    'FGA_OS_STRICT_WEBHOOK_VERIFICATION',
    'FGA_OS_SIGNED_LEAD_CAPTURE_ENFORCE',
    'FGA_OS_ATOMIC_JOB_CLAIMS_ENABLED',
    'FGA_OS_CONTROL_PLANE_API_ENABLED',
    'FGA_OS_DECISION_QUEUE_WRITES_ENABLED',
    'FGA_OS_INCIDENT_RECONCILIATION_WRITES_ENABLED',
    'FGA_OS_CONNECTED_WORKFLOW_WRITES_ENABLED',
    'FGA_OS_CLOSED_WON_ONBOARDING_WRITES_ENABLED',
    'FGA_OS_DOCUMENT_CENTER_API_ENABLED',
    'FGA_OS_DOCUMENT_CENTER_WRITES_ENABLED',
    'FGA_OS_SCHEDULING_CENTER_API_ENABLED',
    'FGA_OS_SCHEDULING_WRITES_ENABLED',
    'FGA_OS_DEPARTMENT_HEADS_ENABLED',
    'FGA_OS_CHIEF_OF_STAFF_ENABLED',
    'FGA_OS_PRODUCTION_AUTHORITY_ENABLED',
  ];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    assert.equal(flags.outcomeObservability(), true);
    assert.equal(flags.authzAppMetadataEnforce(), false);
    assert.equal(flags.strictWebhookVerification(), false);
    assert.equal(flags.signedLeadCapture(), false);
    assert.equal(flags.atomicJobClaims(), false);
    assert.equal(flags.controlPlaneApi(), false);
    assert.equal(flags.decisionQueueWrites(), false);
    assert.equal(flags.incidentReconciliationWrites(), false);
    assert.equal(flags.connectedWorkflowWrites(), false);
    assert.equal(flags.closedWonOnboardingWrites(), false);
    assert.equal(flags.documentCenterApi(), false);
    assert.equal(flags.documentCenterWrites(), false);
    assert.equal(flags.schedulingCenterApi(), false);
    assert.equal(flags.schedulingWrites(), false);
    assert.equal(flags.departmentHeads(), false);
    assert.equal(flags.chiefOfStaff(), false);
    assert.equal(flags.productionAuthority(), false);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
