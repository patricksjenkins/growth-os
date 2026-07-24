'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ContentDeliveryError,
  planArtifactVersionRegistration,
  planQualityRubricRegistration,
  planQualityCalibrationRecording,
  planQualityEvaluationRecording,
  planDeliveryReceiptRecording,
  planContentDeliveryKillSwitch,
} = require('../../core/content/delivery-quality-planner');

const TENANT = '11111111-1111-4111-8111-111111111111';
const DRAFT = '22222222-2222-4222-8222-222222222222';
const VERSION = '33333333-3333-4333-8333-333333333333';
const RUBRIC = '44444444-4444-4444-8444-444444444444';
const CALIBRATION = '55555555-5555-4555-8555-555555555555';
const EVALUATION = '66666666-6666-4666-8666-666666666666';
const WORK = '77777777-7777-4777-8777-777777777777';
const DIGEST = 'a'.repeat(64);

function common(overrides = {}) {
  return {
    tenantId: TENANT,
    evidenceDigest: DIGEST,
    evidenceObservedAt: '2026-07-24T12:00:00.000Z',
    actorId: 'content-shadow-worker',
    idempotencyKey: 'content:evidence:command:001',
    ...overrides,
  };
}

function delivery(overrides = {}) {
  return common({
    contentVersionId: VERSION,
    qualityEvaluationId: EVALUATION,
    ownerWorkItemId: null,
    provider: 'buffer',
    providerAccountRef: 'account_shadow_01',
    providerDeliveryId: 'delivery_shadow_01',
    destinationRef: 'linkedin_org_shadow_01',
    attemptNumber: 1,
    executionState: 'completed',
    outputState: 'produced',
    qualityState: 'accepted',
    deliveryState: 'delivered',
    businessEffectState: 'unverified',
    retryState: 'not_applicable',
    nextRetryAt: null,
    businessEffectEvidenceDigest: null,
    ...overrides,
  });
}

function expectCode(fn, code) {
  assert.throws(fn, error => (
    error instanceof ContentDeliveryError && error.code === code
  ));
}

test('artifact planner is deterministic and remains disabled by default', () => {
  const input = common({
    contentDraftId: DRAFT,
    version: 1,
    contentType: 'linkedin_carousel',
    artifactDigest: 'b'.repeat(64),
  });
  const first = planArtifactVersionRegistration(input);
  const second = planArtifactVersionRegistration(input);

  assert.deepEqual(first, second);
  assert.equal(first.rpc, 'content_artifact_version_register_rpc');
  assert.equal(first.args.p_feature_gate_enabled, false);
  assert.match(first.args.p_request_fingerprint, /^[a-f0-9]{64}$/);
});

test('rubric and calibration planners preserve versioned evidence', () => {
  const rubric = planQualityRubricRegistration(common({
    rubricKey: 'linkedin_final',
    version: 3,
    acceptanceThreshold: 82.5,
    criteria: { brand_accuracy: { weight: 50 }, usefulness: { weight: 50 } },
  }));
  assert.equal(rubric.args.p_version, 3);
  assert.equal(rubric.args.p_acceptance_threshold, 82.5);
  assert.match(rubric.args.p_criteria_digest, /^[a-f0-9]{64}$/);

  const calibration = planQualityCalibrationRecording(common({
    rubricId: RUBRIC,
    sampleCount: 25,
    agreementBasisPoints: 9200,
    benchmarkSetDigest: 'b'.repeat(64),
    scorerConfigDigest: 'c'.repeat(64),
  }));
  assert.equal(calibration.rpc, 'content_quality_calibration_record_rpc');
  assert.equal(calibration.args.p_sample_count, 25);
  assert.equal(calibration.args.p_feature_gate_enabled, false);
});

test('evaluation planner validates category scores and calibrated identity', () => {
  const command = planQualityEvaluationRecording(common({
    contentVersionId: VERSION,
    rubricId: RUBRIC,
    calibrationId: CALIBRATION,
    overallScore: 91,
    categoryScores: { brand_accuracy: 94, usefulness: 88 },
    qualityState: 'accepted',
  }));
  assert.equal(command.rpc, 'content_quality_evaluation_record_rpc');
  assert.equal(command.args.p_calibration_id, CALIBRATION);

  expectCode(() => planQualityEvaluationRecording(common({
    contentVersionId: VERSION,
    rubricId: RUBRIC,
    calibrationId: CALIBRATION,
    overallScore: 91,
    categoryScores: { brand_accuracy: 101 },
    qualityState: 'accepted',
  })), 'CATEGORY_SCORES_INVALID');
});

test('a completed handler with no output cannot become a green receipt', () => {
  for (const overrides of [
    { outputState: 'no_op' },
    { outputState: 'no_output', businessEffectState: 'achieved', businessEffectEvidenceDigest: DIGEST },
  ]) {
    expectCode(
      () => planDeliveryReceiptRecording(delivery(overrides)),
      'FALSE_GREEN_OUTCOME',
    );
  }
});

test('delivered requires accepted calibrated quality evidence', () => {
  expectCode(
    () => planDeliveryReceiptRecording(delivery({ qualityEvaluationId: null })),
    'DELIVERY_EVIDENCE_INCOMPLETE',
  );
  expectCode(
    () => planDeliveryReceiptRecording(delivery({ qualityState: 'unverified' })),
    'DELIVERY_EVIDENCE_INCOMPLETE',
  );
  expectCode(
    () => planDeliveryReceiptRecording(delivery({
      deliveryState: 'accepted',
      qualityState: 'accepted',
      qualityEvaluationId: null,
    })),
    'QUALITY_EVIDENCE_MISMATCH',
  );
});

test('failed, stuck, and exception states require owner work linkage', () => {
  for (const deliveryState of ['failed', 'stuck', 'exception']) {
    expectCode(
      () => planDeliveryReceiptRecording(delivery({
        deliveryState,
        executionState: 'failed',
        qualityEvaluationId: null,
        qualityState: 'unverified',
        ownerWorkItemId: null,
        retryState: deliveryState === 'failed' ? 'exhausted' : 'none',
      })),
      'OWNER_WORK_REQUIRED',
    );
  }

  const failed = planDeliveryReceiptRecording(delivery({
    deliveryState: 'failed',
    executionState: 'failed',
    qualityEvaluationId: null,
    qualityState: 'unverified',
    ownerWorkItemId: WORK,
    retryState: 'scheduled',
    nextRetryAt: '2026-07-24T13:00:00Z',
  }));
  assert.equal(failed.args.p_owner_work_item_id, WORK);
});

test('retry schedule and business effect require exact evidence', () => {
  expectCode(
    () => planDeliveryReceiptRecording(delivery({
      retryState: 'scheduled',
      nextRetryAt: null,
    })),
    'RETRY_EVIDENCE_INVALID',
  );
  expectCode(
    () => planDeliveryReceiptRecording(delivery({
      businessEffectState: 'achieved',
      businessEffectEvidenceDigest: null,
    })),
    'BUSINESS_EFFECT_EVIDENCE_INVALID',
  );
  expectCode(
    () => planDeliveryReceiptRecording(delivery({
      deliveryState: 'accepted',
      businessEffectState: 'achieved',
      businessEffectEvidenceDigest: DIGEST,
    })),
    'FALSE_GREEN_OUTCOME',
  );
});

test('planner rejects raw provider payloads, PII-like refs, and credentials', () => {
  expectCode(
    () => planDeliveryReceiptRecording(delivery({ rawPayload: { ignored: true } })),
    'SENSITIVE_INPUT_FORBIDDEN',
  );
  expectCode(
    () => planDeliveryReceiptRecording(delivery({ destinationRef: 'person@example.com' })),
    'DESTINATION_REF_INVALID',
  );
});

test('kill-switch planner emits a tenant-scoped containment-only command', () => {
  const command = planContentDeliveryKillSwitch({
    tenantId: TENANT,
    reasonCode: 'provider_receipt_mismatch',
  });
  assert.deepEqual(command, {
    rpc: 'content_delivery_kill_switch_rpc',
    args: {
      p_tenant_id: TENANT,
      p_reason: 'provider_receipt_mismatch',
    },
  });
  assert.equal('p_feature_gate_enabled' in command.args, false);
  expectCode(
    () => planContentDeliveryKillSwitch({
      tenantId: TENANT,
      reasonCode: 'contains spaces',
    }),
    'KILL_SWITCH_REASON_INVALID',
  );
});
