'use strict';

/**
 * Pure, no-I/O planners for migration 082.
 *
 * These planners create disabled-by-default RPC envelopes from opaque
 * identifiers and evidence digests. They cannot publish content, call a
 * provider, or activate the database control.
 */

const crypto = require('node:crypto');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CODE = /^[a-z][a-z0-9_]{1,63}$/;
const OPAQUE_REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,254}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const EXECUTION_STATES = new Set(['completed', 'failed']);
const OUTPUT_STATES = new Set(['produced', 'no_output', 'no_op']);
const QUALITY_STATES = new Set(['accepted', 'rejected', 'unverified']);
const DELIVERY_STATES = new Set(['accepted', 'delivered', 'failed', 'stuck', 'exception']);
const BUSINESS_STATES = new Set(['achieved', 'not_achieved', 'unverified', 'not_applicable']);
const RETRY_STATES = new Set(['not_applicable', 'none', 'scheduled', 'exhausted']);
const FORBIDDEN_KEYS = new Set([
  'rawPayload', 'payload', 'body', 'customerEmail', 'customerName',
  'accessToken', 'token', 'secret', 'providerCredentials',
]);

class ContentDeliveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ContentDeliveryError';
    this.code = code;
  }
}

function requiredString(value, errorCode, label, min = 1, max = 200) {
  const normalized = String(value || '').trim();
  if (normalized.length < min || normalized.length > max) {
    throw new ContentDeliveryError(errorCode, `${label} has an invalid length`);
  }
  return normalized;
}

function uuid(value, errorCode, label, optional = false) {
  if (optional && (value === null || value === undefined || value === '')) return null;
  const normalized = requiredString(value, errorCode, label, 36, 36).toLowerCase();
  if (!UUID.test(normalized)) {
    throw new ContentDeliveryError(errorCode, `${label} must be a UUID`);
  }
  return normalized;
}

function code(value, errorCode, label) {
  const normalized = requiredString(value, errorCode, label, 2, 64).toLowerCase();
  if (!CODE.test(normalized)) {
    throw new ContentDeliveryError(errorCode, `${label} must be a lower-case code`);
  }
  return normalized;
}

function opaqueRef(value, errorCode, label) {
  const normalized = requiredString(value, errorCode, label, 2, 255);
  if (!OPAQUE_REF.test(normalized) || normalized.includes('@')) {
    throw new ContentDeliveryError(errorCode, `${label} must be an opaque non-PII reference`);
  }
  return normalized;
}

function digest(value, errorCode, label) {
  const normalized = requiredString(value, errorCode, label, 64, 64).toLowerCase();
  if (!SHA256.test(normalized)) {
    throw new ContentDeliveryError(errorCode, `${label} must be a sha256 digest`);
  }
  return normalized;
}

function timestamp(value, errorCode, label, optional = false) {
  if (optional && (value === null || value === undefined || value === '')) return null;
  const parsed = Date.parse(requiredString(value, errorCode, label, 20, 40));
  if (!Number.isFinite(parsed)) {
    throw new ContentDeliveryError(errorCode, `${label} must be an ISO timestamp`);
  }
  return new Date(parsed).toISOString();
}

function positiveInteger(value, errorCode, label, allowZero = false) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new ContentDeliveryError(errorCode, `${label} must be a safe integer`);
  }
  return value;
}

function score(value, errorCode, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new ContentDeliveryError(errorCode, `${label} must be between 0 and 100`);
  }
  return value;
}

function object(value, errorCode, label, nonEmpty = true) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || (nonEmpty && Object.keys(value).length === 0)) {
    throw new ContentDeliveryError(errorCode, `${label} must be an object`);
  }
  return value;
}

function assertNoSensitiveKeys(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ContentDeliveryError('COMMAND_REQUIRED', 'command input is required');
  }
  for (const key of FORBIDDEN_KEYS) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      throw new ContentDeliveryError(
        'SENSITIVE_INPUT_FORBIDDEN',
        `content evidence commands must not contain ${key}`,
      );
    }
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      key => `${JSON.stringify(key)}:${stableJson(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

function common(input) {
  assertNoSensitiveKeys(input);
  return {
    tenantId: uuid(input.tenantId, 'TENANT_ID_INVALID', 'tenantId'),
    evidenceDigest: digest(input.evidenceDigest, 'EVIDENCE_DIGEST_INVALID', 'evidenceDigest'),
    evidenceObservedAt: timestamp(
      input.evidenceObservedAt,
      'EVIDENCE_TIME_INVALID',
      'evidenceObservedAt',
    ),
    idempotencyKey: requiredString(
      input.idempotencyKey,
      'IDEMPOTENCY_KEY_INVALID',
      'idempotencyKey',
      8,
      200,
    ),
    actorId: requiredString(input.actorId, 'ACTOR_ID_INVALID', 'actorId', 2, 160),
  };
}

function command(rpc, semantics, args) {
  const requestFingerprint = fingerprint(semantics);
  return Object.freeze({
    rpc,
    args: Object.freeze({
      ...args,
      p_request_fingerprint: requestFingerprint,
      p_feature_gate_enabled: false,
    }),
  });
}

function planArtifactVersionRegistration(input) {
  const c = common(input);
  const draftId = uuid(input.contentDraftId, 'CONTENT_DRAFT_ID_INVALID', 'contentDraftId');
  const version = positiveInteger(input.version, 'CONTENT_VERSION_INVALID', 'version');
  const artifactDigest = digest(
    input.artifactDigest,
    'ARTIFACT_DIGEST_INVALID',
    'artifactDigest',
  );
  const contentType = code(input.contentType, 'CONTENT_TYPE_INVALID', 'contentType');
  const semantics = { ...c, draftId, version, artifactDigest, contentType };
  return command('content_artifact_version_register_rpc', semantics, {
    p_tenant_id: c.tenantId,
    p_content_draft_id: draftId,
    p_version: version,
    p_content_type: contentType,
    p_artifact_digest: artifactDigest,
    p_evidence_digest: c.evidenceDigest,
    p_evidence_observed_at: c.evidenceObservedAt,
    p_actor_id: c.actorId,
    p_idempotency_key: c.idempotencyKey,
  });
}

function planQualityRubricRegistration(input) {
  const c = common(input);
  const rubricKey = code(input.rubricKey, 'RUBRIC_KEY_INVALID', 'rubricKey');
  const version = positiveInteger(input.version, 'RUBRIC_VERSION_INVALID', 'version');
  const threshold = score(input.acceptanceThreshold, 'RUBRIC_THRESHOLD_INVALID', 'acceptanceThreshold');
  const criteria = object(input.criteria, 'RUBRIC_CRITERIA_INVALID', 'criteria');
  const criteriaDigest = fingerprint(criteria);
  const semantics = { ...c, rubricKey, version, threshold, criteriaDigest };
  return command('content_quality_rubric_register_rpc', semantics, {
    p_tenant_id: c.tenantId,
    p_rubric_key: rubricKey,
    p_version: version,
    p_acceptance_threshold: threshold,
    p_criteria: criteria,
    p_criteria_digest: criteriaDigest,
    p_evidence_digest: c.evidenceDigest,
    p_evidence_observed_at: c.evidenceObservedAt,
    p_actor_id: c.actorId,
    p_idempotency_key: c.idempotencyKey,
  });
}

function planQualityCalibrationRecording(input) {
  const c = common(input);
  const rubricId = uuid(input.rubricId, 'RUBRIC_ID_INVALID', 'rubricId');
  const sampleCount = positiveInteger(input.sampleCount, 'SAMPLE_COUNT_INVALID', 'sampleCount');
  const agreementBasisPoints = positiveInteger(
    input.agreementBasisPoints,
    'CALIBRATION_AGREEMENT_INVALID',
    'agreementBasisPoints',
    true,
  );
  if (agreementBasisPoints > 10000) {
    throw new ContentDeliveryError(
      'CALIBRATION_AGREEMENT_INVALID',
      'agreementBasisPoints cannot exceed 10000',
    );
  }
  const benchmarkSetDigest = digest(
    input.benchmarkSetDigest,
    'BENCHMARK_DIGEST_INVALID',
    'benchmarkSetDigest',
  );
  const scorerConfigDigest = digest(
    input.scorerConfigDigest,
    'SCORER_DIGEST_INVALID',
    'scorerConfigDigest',
  );
  const semantics = {
    ...c, rubricId, sampleCount, agreementBasisPoints,
    benchmarkSetDigest, scorerConfigDigest,
  };
  return command('content_quality_calibration_record_rpc', semantics, {
    p_tenant_id: c.tenantId,
    p_rubric_id: rubricId,
    p_sample_count: sampleCount,
    p_agreement_basis_points: agreementBasisPoints,
    p_benchmark_set_digest: benchmarkSetDigest,
    p_scorer_config_digest: scorerConfigDigest,
    p_evidence_digest: c.evidenceDigest,
    p_evidence_observed_at: c.evidenceObservedAt,
    p_actor_id: c.actorId,
    p_idempotency_key: c.idempotencyKey,
  });
}

function planQualityEvaluationRecording(input) {
  const c = common(input);
  const contentVersionId = uuid(
    input.contentVersionId,
    'CONTENT_VERSION_ID_INVALID',
    'contentVersionId',
  );
  const rubricId = uuid(input.rubricId, 'RUBRIC_ID_INVALID', 'rubricId');
  const calibrationId = uuid(input.calibrationId, 'CALIBRATION_ID_INVALID', 'calibrationId');
  const overallScore = score(input.overallScore, 'QUALITY_SCORE_INVALID', 'overallScore');
  const qualityState = code(input.qualityState, 'QUALITY_STATE_INVALID', 'qualityState');
  if (!QUALITY_STATES.has(qualityState)) {
    throw new ContentDeliveryError('QUALITY_STATE_INVALID', 'qualityState is unsupported');
  }
  const categoryScores = object(
    input.categoryScores,
    'CATEGORY_SCORES_INVALID',
    'categoryScores',
  );
  for (const value of Object.values(categoryScores)) {
    score(value, 'CATEGORY_SCORES_INVALID', 'category score');
  }
  const semantics = {
    ...c, contentVersionId, rubricId, calibrationId,
    overallScore, qualityState, categoryScores,
  };
  return command('content_quality_evaluation_record_rpc', semantics, {
    p_tenant_id: c.tenantId,
    p_content_version_id: contentVersionId,
    p_rubric_id: rubricId,
    p_calibration_id: calibrationId,
    p_overall_score: overallScore,
    p_category_scores: categoryScores,
    p_quality_state: qualityState,
    p_evidence_digest: c.evidenceDigest,
    p_evidence_observed_at: c.evidenceObservedAt,
    p_actor_id: c.actorId,
    p_idempotency_key: c.idempotencyKey,
  });
}

function planDeliveryReceiptRecording(input) {
  const c = common(input);
  const contentVersionId = uuid(
    input.contentVersionId,
    'CONTENT_VERSION_ID_INVALID',
    'contentVersionId',
  );
  const qualityEvaluationId = uuid(
    input.qualityEvaluationId,
    'QUALITY_EVALUATION_ID_INVALID',
    'qualityEvaluationId',
    true,
  );
  const ownerWorkItemId = uuid(
    input.ownerWorkItemId,
    'OWNER_WORK_ITEM_ID_INVALID',
    'ownerWorkItemId',
    true,
  );
  const provider = code(input.provider, 'PROVIDER_INVALID', 'provider');
  const providerAccountRef = opaqueRef(
    input.providerAccountRef,
    'PROVIDER_ACCOUNT_REF_INVALID',
    'providerAccountRef',
  );
  const providerDeliveryId = opaqueRef(
    input.providerDeliveryId,
    'PROVIDER_DELIVERY_ID_INVALID',
    'providerDeliveryId',
  );
  const destinationRef = opaqueRef(
    input.destinationRef,
    'DESTINATION_REF_INVALID',
    'destinationRef',
  );
  const attemptNumber = positiveInteger(
    input.attemptNumber,
    'ATTEMPT_NUMBER_INVALID',
    'attemptNumber',
  );
  const executionState = code(input.executionState, 'EXECUTION_STATE_INVALID', 'executionState');
  const outputState = code(input.outputState, 'OUTPUT_STATE_INVALID', 'outputState');
  const qualityState = code(input.qualityState, 'QUALITY_STATE_INVALID', 'qualityState');
  const deliveryState = code(input.deliveryState, 'DELIVERY_STATE_INVALID', 'deliveryState');
  const businessEffectState = code(
    input.businessEffectState,
    'BUSINESS_EFFECT_STATE_INVALID',
    'businessEffectState',
  );
  const retryState = code(input.retryState, 'RETRY_STATE_INVALID', 'retryState');
  if (!EXECUTION_STATES.has(executionState)
      || !OUTPUT_STATES.has(outputState)
      || !QUALITY_STATES.has(qualityState)
      || !DELIVERY_STATES.has(deliveryState)
      || !BUSINESS_STATES.has(businessEffectState)
      || !RETRY_STATES.has(retryState)) {
    throw new ContentDeliveryError('OUTCOME_STATE_INVALID', 'one or more outcome states are unsupported');
  }
  const nextRetryAt = timestamp(
    input.nextRetryAt,
    'NEXT_RETRY_AT_INVALID',
    'nextRetryAt',
    true,
  );
  const businessEffectEvidenceDigest = input.businessEffectEvidenceDigest
    ? digest(
      input.businessEffectEvidenceDigest,
      'BUSINESS_EFFECT_EVIDENCE_INVALID',
      'businessEffectEvidenceDigest',
    )
    : null;

  if (outputState !== 'produced'
      && (qualityState === 'accepted'
        || deliveryState === 'delivered'
        || businessEffectState === 'achieved')) {
    throw new ContentDeliveryError(
      'FALSE_GREEN_OUTCOME',
      'no-output and no-op execution cannot be accepted, delivered, or achieved',
    );
  }
  if (deliveryState === 'delivered'
      && (executionState !== 'completed'
        || outputState !== 'produced'
        || qualityState !== 'accepted'
        || !qualityEvaluationId)) {
    throw new ContentDeliveryError(
      'DELIVERY_EVIDENCE_INCOMPLETE',
      'delivered requires completed execution, produced output, and accepted quality evidence',
    );
  }
  if ((qualityState === 'unverified') !== (qualityEvaluationId === null)) {
    throw new ContentDeliveryError(
      'QUALITY_EVIDENCE_MISMATCH',
      'accepted or rejected quality requires an evaluation; unverified forbids one',
    );
  }
  if (['failed', 'stuck', 'exception'].includes(deliveryState) && !ownerWorkItemId) {
    throw new ContentDeliveryError(
      'OWNER_WORK_REQUIRED',
      'failed, stuck, and exception delivery states require an owner work item',
    );
  }
  if ((retryState === 'scheduled') !== Boolean(nextRetryAt)) {
    throw new ContentDeliveryError(
      'RETRY_EVIDENCE_INVALID',
      'scheduled retry requires nextRetryAt and other retry states forbid it',
    );
  }
  if (nextRetryAt
      && Date.parse(nextRetryAt) <= Date.parse(c.evidenceObservedAt)) {
    throw new ContentDeliveryError(
      'RETRY_EVIDENCE_INVALID',
      'nextRetryAt must be later than the observed delivery evidence',
    );
  }
  if (['achieved', 'not_achieved'].includes(businessEffectState)
      !== Boolean(businessEffectEvidenceDigest)) {
    throw new ContentDeliveryError(
      'BUSINESS_EFFECT_EVIDENCE_INVALID',
      'observed business effects require evidence and unobserved states forbid it',
    );
  }
  if (businessEffectState === 'achieved'
      && (deliveryState !== 'delivered'
        || qualityState !== 'accepted'
        || outputState !== 'produced')) {
    throw new ContentDeliveryError(
      'FALSE_GREEN_OUTCOME',
      'achieved business effect requires delivered, accepted, produced content',
    );
  }

  const semantics = {
    ...c, contentVersionId, qualityEvaluationId, ownerWorkItemId,
    provider, providerAccountRef, providerDeliveryId, destinationRef,
    attemptNumber, executionState, outputState, qualityState, deliveryState,
    businessEffectState, retryState, nextRetryAt, businessEffectEvidenceDigest,
  };
  return command('content_delivery_receipt_record_rpc', semantics, {
    p_tenant_id: c.tenantId,
    p_content_version_id: contentVersionId,
    p_quality_evaluation_id: qualityEvaluationId,
    p_owner_work_item_id: ownerWorkItemId,
    p_provider: provider,
    p_provider_account_ref: providerAccountRef,
    p_provider_delivery_id: providerDeliveryId,
    p_destination_ref: destinationRef,
    p_attempt_number: attemptNumber,
    p_execution_state: executionState,
    p_output_state: outputState,
    p_quality_state: qualityState,
    p_delivery_state: deliveryState,
    p_business_effect_state: businessEffectState,
    p_retry_state: retryState,
    p_next_retry_at: nextRetryAt,
    p_business_effect_evidence_digest: businessEffectEvidenceDigest,
    p_evidence_digest: c.evidenceDigest,
    p_evidence_observed_at: c.evidenceObservedAt,
    p_actor_id: c.actorId,
    p_idempotency_key: c.idempotencyKey,
  });
}

function planContentDeliveryKillSwitch(input) {
  assertNoSensitiveKeys(input);
  const tenantId = uuid(input.tenantId, 'TENANT_ID_INVALID', 'tenantId');
  const reasonCode = code(
    input.reasonCode,
    'KILL_SWITCH_REASON_INVALID',
    'reasonCode',
  );
  return Object.freeze({
    rpc: 'content_delivery_kill_switch_rpc',
    args: Object.freeze({
      p_tenant_id: tenantId,
      p_reason: reasonCode,
    }),
  });
}

module.exports = {
  ContentDeliveryError,
  planArtifactVersionRegistration,
  planQualityRubricRegistration,
  planQualityCalibrationRecording,
  planQualityEvaluationRecording,
  planDeliveryReceiptRecording,
  planContentDeliveryKillSwitch,
};
