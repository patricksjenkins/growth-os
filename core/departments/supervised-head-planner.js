'use strict';

const crypto = require('node:crypto');
const {
  departmentContract,
  evaluateDepartmentAction,
} = require('./catalog');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const CODE_PATTERN = /^[a-z][a-z0-9_]{2,79}$/;
const REPORT_HEALTH = new Set(['unknown', 'unproven', 'at_risk', 'healthy']);
const KPI_STATES = new Set(['unknown', 'unproven', 'missed', 'met']);
const RECORD_TYPES = new Set(['goal', 'work', 'decision', 'exception', 'evidence']);
const RECORD_ACTIONS = new Set([
  'create_record',
  'accept_assignment',
  'escalate',
  'complete',
  'record_outcome',
]);
const FORBIDDEN_KEYS = new Set([
  'rawPayload',
  'providerToken',
  'secret',
  'customerEmail',
  'customerPhone',
  'customerName',
  'sendEmail',
  'sendSms',
  'sendNotification',
  'placeCall',
  'publish',
  'deploy',
  'migrationSql',
  'paymentMethod',
  'bankAccount',
]);

class SupervisedHeadPlanningError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SupervisedHeadPlanningError';
    this.code = code;
  }
}

function requiredString(value, code, label, minimum = 1, maximum = 240) {
  const normalized = String(value || '').trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new SupervisedHeadPlanningError(code, `${label} has an invalid length`);
  }
  return normalized;
}

function uuid(value, code, label) {
  const normalized = requiredString(value, code, label, 36, 36).toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    throw new SupervisedHeadPlanningError(code, `${label} must be a UUID`);
  }
  return normalized;
}

function digest(value, code, label) {
  const normalized = requiredString(value, code, label, 64, 64).toLowerCase();
  if (!DIGEST_PATTERN.test(normalized)) {
    throw new SupervisedHeadPlanningError(code, `${label} must be a SHA-256 digest`);
  }
  return normalized;
}

function timestamp(value, code, label) {
  const normalized = requiredString(value, code, label, 20, 40);
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    throw new SupervisedHeadPlanningError(code, `${label} must be an ISO timestamp`);
  }
  return new Date(parsed).toISOString();
}

function optionalTimestamp(value, code, label) {
  if (value === undefined || value === null || value === '') return null;
  return timestamp(value, code, label);
}

function code(value, errorCode, label) {
  const normalized = requiredString(value, errorCode, label, 3, 80).toLowerCase();
  if (!CODE_PATTERN.test(normalized)) {
    throw new SupervisedHeadPlanningError(errorCode, `${label} must be a stable code`);
  }
  return normalized;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      key => `${JSON.stringify(key)}:${stableJson(value[key])}`
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function assertObject(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new SupervisedHeadPlanningError('COMMAND_REQUIRED', 'command input is required');
  }
  for (const forbidden of FORBIDDEN_KEYS) {
    if (Object.prototype.hasOwnProperty.call(input, forbidden)) {
      throw new SupervisedHeadPlanningError(
        'EXTERNAL_OR_SENSITIVE_ACTION_FORBIDDEN',
        `supervised Department Head input cannot contain ${forbidden}`,
      );
    }
  }
}

function normalizeEnvelope(input) {
  if (input.featureGateEnabled !== true) {
    throw new SupervisedHeadPlanningError(
      'FEATURE_GATE_DISABLED',
      'featureGateEnabled must be explicitly true',
    );
  }
  if (input.executionMode !== 'shadow') {
    throw new SupervisedHeadPlanningError(
      'SHADOW_MODE_REQUIRED',
      'new Department Head planners run only in shadow mode',
    );
  }
  const tenantId = uuid(input.tenantId, 'TENANT_ID_INVALID', 'tenantId');
  const departmentKey = code(
    input.departmentKey,
    'DEPARTMENT_INVALID',
    'departmentKey',
  );
  const contract = departmentContract(departmentKey);
  const expectedControlRevision = Number(input.expectedControlRevision);
  if (!Number.isSafeInteger(expectedControlRevision) || expectedControlRevision < 0) {
    throw new SupervisedHeadPlanningError(
      'CONTROL_REVISION_INVALID',
      'expectedControlRevision must be a non-negative safe integer',
    );
  }
  return {
    tenantId,
    departmentKey,
    contract,
    expectedControlRevision,
    idempotencyKey: requiredString(
      input.idempotencyKey,
      'IDEMPOTENCY_KEY_INVALID',
      'idempotencyKey',
      8,
      200,
    ),
    requestFingerprint: digest(
      input.requestFingerprint,
      'REQUEST_FINGERPRINT_INVALID',
      'requestFingerprint',
    ),
  };
}

function normalizeEvidenceReceipts(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new SupervisedHeadPlanningError(
      'EVIDENCE_RECEIPTS_REQUIRED',
      'evidenceReceipts must contain 1 to 100 receipts',
    );
  }
  return value.map((receipt, index) => {
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
      throw new SupervisedHeadPlanningError(
        'EVIDENCE_RECEIPT_INVALID',
        `evidenceReceipts[${index}] must be an object`,
      );
    }
    return {
      sourceType: code(
        receipt.sourceType,
        'EVIDENCE_SOURCE_TYPE_INVALID',
        `evidenceReceipts[${index}].sourceType`,
      ),
      sourceId: requiredString(
        receipt.sourceId,
        'EVIDENCE_SOURCE_ID_INVALID',
        `evidenceReceipts[${index}].sourceId`,
        3,
        240,
      ),
      evidenceDigest: digest(
        receipt.evidenceDigest,
        'EVIDENCE_DIGEST_INVALID',
        `evidenceReceipts[${index}].evidenceDigest`,
      ),
      observedAt: timestamp(
        receipt.observedAt,
        'EVIDENCE_TIME_INVALID',
        `evidenceReceipts[${index}].observedAt`,
      ),
    };
  });
}

function planDepartmentReport(input = {}) {
  assertObject(input);
  const envelope = normalizeEnvelope(input);
  const reportType = code(input.reportType, 'REPORT_TYPE_INVALID', 'reportType');
  if (!envelope.contract.acceptedReportTypes.includes(reportType)) {
    throw new SupervisedHeadPlanningError(
      'REPORT_TYPE_NOT_ACCEPTED',
      'report type is not accepted by this Department Head contract',
    );
  }
  const reportId = uuid(input.reportId, 'REPORT_ID_INVALID', 'reportId');
  const periodStartedAt = timestamp(
    input.periodStartedAt,
    'PERIOD_START_INVALID',
    'periodStartedAt',
  );
  const periodEndedAt = timestamp(
    input.periodEndedAt,
    'PERIOD_END_INVALID',
    'periodEndedAt',
  );
  if (Date.parse(periodEndedAt) <= Date.parse(periodStartedAt)) {
    throw new SupervisedHeadPlanningError(
      'REPORT_PERIOD_INVALID',
      'periodEndedAt must be after periodStartedAt',
    );
  }
  if (!Array.isArray(input.kpiObservations) || input.kpiObservations.length === 0) {
    throw new SupervisedHeadPlanningError(
      'KPI_OBSERVATIONS_REQUIRED',
      'kpiObservations must be a non-empty array',
    );
  }
  const seenKpis = new Set();
  const kpiObservations = input.kpiObservations.map((observation, index) => {
    if (!observation || typeof observation !== 'object' || Array.isArray(observation)) {
      throw new SupervisedHeadPlanningError(
        'KPI_OBSERVATION_INVALID',
        `kpiObservations[${index}] must be an object`,
      );
    }
    const kpi = code(
      observation.kpi,
      'KPI_INVALID',
      `kpiObservations[${index}].kpi`,
    );
    if (!envelope.contract.kpis.includes(kpi) || seenKpis.has(kpi)) {
      throw new SupervisedHeadPlanningError(
        'KPI_NOT_ACCEPTED',
        'KPI must be unique and registered to the Department Head',
      );
    }
    seenKpis.add(kpi);
    const state = code(
      observation.state,
      'KPI_STATE_INVALID',
      `kpiObservations[${index}].state`,
    );
    if (!KPI_STATES.has(state)) {
      throw new SupervisedHeadPlanningError(
        'KPI_STATE_INVALID',
        'KPI state is unsupported',
      );
    }
    return {
      kpi,
      state,
      valueDigest: digest(
        observation.valueDigest,
        'KPI_VALUE_DIGEST_INVALID',
        `kpiObservations[${index}].valueDigest`,
      ),
      evidenceDigest: digest(
        observation.evidenceDigest,
        'KPI_EVIDENCE_DIGEST_INVALID',
        `kpiObservations[${index}].evidenceDigest`,
      ),
    };
  });
  const evidenceReceipts = normalizeEvidenceReceipts(input.evidenceReceipts);
  const requestedHealth = code(
    input.outcomeHealth,
    'OUTCOME_HEALTH_INVALID',
    'outcomeHealth',
  );
  if (!REPORT_HEALTH.has(requestedHealth)) {
    throw new SupervisedHeadPlanningError(
      'OUTCOME_HEALTH_INVALID',
      'outcomeHealth is unsupported',
    );
  }
  const allKpisObservedAndMet = envelope.contract.kpis.every(
    kpi => kpiObservations.some(
      observation => observation.kpi === kpi && observation.state === 'met',
    ),
  );
  if (requestedHealth === 'healthy' && !allKpisObservedAndMet) {
    throw new SupervisedHeadPlanningError(
      'FALSE_GREEN_FORBIDDEN',
      'healthy requires an observed met receipt for every registered KPI',
    );
  }
  const planned = {
    ...envelope,
    contract: undefined,
    reportId,
    reportType,
    periodStartedAt,
    periodEndedAt,
    kpiObservations,
    evidenceReceipts,
    outcomeHealth: requestedHealth,
    accepted: false,
    acceptanceAuthority: 'same_tenant_privileged_human',
    externalActionPermitted: false,
    productionWriteAuthority: false,
  };
  planned.semanticFingerprint = sha256(stableJson(planned));
  return planned;
}

function planDepartmentRecordCommand(input = {}) {
  assertObject(input);
  const envelope = normalizeEnvelope(input);
  const recordId = uuid(input.recordId, 'RECORD_ID_INVALID', 'recordId');
  const recordType = code(input.recordType, 'RECORD_TYPE_INVALID', 'recordType');
  const action = code(input.action, 'ACTION_INVALID', 'action');
  if (!RECORD_TYPES.has(recordType) || !RECORD_ACTIONS.has(action)) {
    throw new SupervisedHeadPlanningError(
      'RECORD_COMMAND_INVALID',
      'record type or action is unsupported',
    );
  }
  const delegatedAction = requiredString(
    input.delegatedAction,
    'DELEGATED_ACTION_INVALID',
    'delegatedAction',
    3,
    120,
  );
  const authority = evaluateDepartmentAction(envelope.departmentKey, delegatedAction);
  if (authority.decision !== 'allow_shadow') {
    throw new SupervisedHeadPlanningError(
      authority.decision === 'owner_approval_required'
        ? 'OWNER_APPROVAL_REQUIRED'
        : 'ACTION_NOT_AUTHORIZED',
      `delegated action is not permitted in shadow mode: ${authority.reason}`,
    );
  }
  const expectedRevision = Number(input.expectedRevision);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new SupervisedHeadPlanningError(
      'REVISION_INVALID',
      'expectedRevision must be a non-negative safe integer',
    );
  }
  const evidenceReceipts = normalizeEvidenceReceipts(input.evidenceReceipts);
  const planned = {
    ...envelope,
    contract: undefined,
    recordId,
    recordType,
    action,
    delegatedAction,
    expectedRevision,
    ownerId: uuid(input.ownerId, 'OWNER_ID_INVALID', 'ownerId'),
    assigneeId: uuid(input.assigneeId, 'ASSIGNEE_ID_INVALID', 'assigneeId'),
    slaDueAt: optionalTimestamp(input.slaDueAt, 'SLA_DUE_INVALID', 'slaDueAt'),
    evidenceReceipts,
    authorityDecision: authority.decision,
    externalActionPermitted: false,
    productionWriteAuthority: false,
  };
  if (action === 'create_record' && !planned.slaDueAt) {
    throw new SupervisedHeadPlanningError(
      'SLA_DUE_REQUIRED',
      'new department records require an SLA due time',
    );
  }
  planned.semanticFingerprint = sha256(stableJson(planned));
  return planned;
}

module.exports = {
  SupervisedHeadPlanningError,
  planDepartmentReport,
  planDepartmentRecordCommand,
};
