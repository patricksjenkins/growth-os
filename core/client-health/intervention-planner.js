'use strict';

const crypto = require('node:crypto');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const CODE_PATTERN = /^[a-z][a-z0-9_]{2,79}$/;
const SIGNAL_STATES = new Set(['unknown', 'unproven', 'at_risk', 'stable']);
const PROVENANCE_TYPES = new Set(['heuristic', 'observed']);
const ACTIONS = new Set([
  'open_intervention',
  'accept_assignment',
  'escalate',
  'complete_action',
  'record_outcome',
]);
const OUTCOME_STATES = new Set(['improved', 'unchanged', 'worsened']);
const ACTOR_TYPES = new Set(['human', 'service', 'system']);
const AUTHORITY_TIERS = new Set(['system', 'client_success', 'owner']);
const FORBIDDEN_KEYS = new Set([
  'customerEmail',
  'customerName',
  'customerPhone',
  'rawCustomer',
  'rawPayload',
  'providerToken',
  'sendEmail',
  'sendSms',
  'sendNotification',
]);

class ClientHealthPlanningError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ClientHealthPlanningError';
    this.code = code;
  }
}

function requiredString(value, code, label, minimum = 1, maximum = 200) {
  const normalized = String(value || '').trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new ClientHealthPlanningError(code, `${label} has an invalid length`);
  }
  return normalized;
}

function normalizeUuid(value, code, label) {
  const normalized = requiredString(value, code, label, 36, 36).toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    throw new ClientHealthPlanningError(code, `${label} must be a UUID`);
  }
  return normalized;
}

function optionalUuid(value, code, label) {
  if (value === undefined || value === null || value === '') return null;
  return normalizeUuid(value, code, label);
}

function normalizeTimestamp(value, code, label) {
  const normalized = requiredString(value, code, label, 20, 40);
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    throw new ClientHealthPlanningError(code, `${label} must be an ISO timestamp`);
  }
  return new Date(parsed).toISOString();
}

function optionalTimestamp(value, code, label) {
  if (value === undefined || value === null || value === '') return null;
  return normalizeTimestamp(value, code, label);
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

function assertNoForbiddenKeys(input) {
  for (const key of FORBIDDEN_KEYS) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      throw new ClientHealthPlanningError(
        'EXTERNAL_ACTION_FORBIDDEN',
        `client-health commands cannot contain ${key}`
      );
    }
  }
}

function normalizeEvidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ClientHealthPlanningError(
      'EVIDENCE_REQUIRED',
      'evidence must be a structured object'
    );
  }
  return {
    ...value,
    source_type: requiredString(
      value.source_type,
      'EVIDENCE_SOURCE_TYPE_INVALID',
      'evidence.source_type',
      3,
      60
    ),
    source_id: requiredString(
      value.source_id,
      'EVIDENCE_SOURCE_ID_INVALID',
      'evidence.source_id',
      3,
      240
    ),
    observed_at: normalizeTimestamp(
      value.observed_at,
      'EVIDENCE_TIME_INVALID',
      'evidence.observed_at'
    ),
  };
}

function normalizeActor(input) {
  const actorType = requiredString(
    input.actorType,
    'ACTOR_TYPE_INVALID',
    'actorType',
    5,
    7
  ).toLowerCase();
  const authorityTier = requiredString(
    input.authorityTier,
    'AUTHORITY_TIER_INVALID',
    'authorityTier',
    5,
    20
  ).toLowerCase();
  if (!ACTOR_TYPES.has(actorType) || !AUTHORITY_TIERS.has(authorityTier)) {
    throw new ClientHealthPlanningError(
      'ACTOR_AUTHORITY_INVALID',
      'actor type or authority tier is unsupported'
    );
  }

  let actorId = null;
  if (actorType === 'human') {
    actorId = normalizeUuid(input.actorId, 'ACTOR_ID_INVALID', 'actorId');
    if (!['client_success', 'owner'].includes(authorityTier)) {
      throw new ClientHealthPlanningError(
        'HUMAN_AUTHORITY_INVALID',
        'human actors require client_success or owner authority'
      );
    }
  } else if (actorType === 'service') {
    actorId = requiredString(input.actorId, 'ACTOR_ID_INVALID', 'actorId', 2, 160);
    if (!['system', 'client_success'].includes(authorityTier)) {
      throw new ClientHealthPlanningError(
        'SERVICE_AUTHORITY_INVALID',
        'service actors require system or client_success authority'
      );
    }
  } else if (
    (input.actorId !== undefined && input.actorId !== null && input.actorId !== '')
    || authorityTier !== 'system'
  ) {
    throw new ClientHealthPlanningError(
      'SYSTEM_ACTOR_INVALID',
      'system actors cannot claim an actor id or elevated authority'
    );
  }
  return { actorType, actorId, authorityTier };
}

function normalizeIdentity(input, includeIntervention = false) {
  const identity = {
    tenantId: normalizeUuid(input.tenantId, 'TENANT_ID_INVALID', 'tenantId'),
    customerId: normalizeUuid(input.customerId, 'CUSTOMER_ID_INVALID', 'customerId'),
    expectedControlRevision: Number(input.expectedControlRevision),
    featureGateEnabled: input.featureGateEnabled === true,
  };
  if (!Number.isSafeInteger(identity.expectedControlRevision)
      || identity.expectedControlRevision < 0) {
    throw new ClientHealthPlanningError(
      'CONTROL_REVISION_INVALID',
      'expectedControlRevision must be a non-negative safe integer'
    );
  }
  if (!identity.featureGateEnabled) {
    throw new ClientHealthPlanningError(
      'FEATURE_GATE_DISABLED',
      'featureGateEnabled must be explicitly true'
    );
  }
  if (includeIntervention) {
    identity.interventionId = normalizeUuid(
      input.interventionId,
      'INTERVENTION_ID_INVALID',
      'interventionId'
    );
  }
  return identity;
}

function normalizeRequestEnvelope(input) {
  const idempotencyKey = requiredString(
    input.idempotencyKey,
    'IDEMPOTENCY_KEY_INVALID',
    'idempotencyKey',
    8,
    200
  );
  const requestFingerprint = requiredString(
    input.requestFingerprint,
    'REQUEST_FINGERPRINT_INVALID',
    'requestFingerprint',
    64,
    64
  ).toLowerCase();
  if (!DIGEST_PATTERN.test(requestFingerprint)) {
    throw new ClientHealthPlanningError(
      'REQUEST_FINGERPRINT_INVALID',
      'requestFingerprint must be a lowercase SHA-256 digest'
    );
  }
  return { idempotencyKey, requestFingerprint };
}

function planClientHealthSignalSnapshot(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ClientHealthPlanningError('COMMAND_REQUIRED', 'command input is required');
  }
  assertNoForbiddenKeys(input);
  const identity = normalizeIdentity(input);
  const snapshotId = normalizeUuid(
    input.snapshotId,
    'SNAPSHOT_ID_INVALID',
    'snapshotId'
  );
  const signalState = requiredString(
    input.signalState,
    'SIGNAL_STATE_INVALID',
    'signalState',
    6,
    10
  ).toLowerCase();
  const provenanceType = requiredString(
    input.provenanceType,
    'PROVENANCE_TYPE_INVALID',
    'provenanceType',
    8,
    9
  ).toLowerCase();
  if (!SIGNAL_STATES.has(signalState) || !PROVENANCE_TYPES.has(provenanceType)) {
    throw new ClientHealthPlanningError(
      'SIGNAL_CONTRACT_INVALID',
      'signal state or provenance type is unsupported'
    );
  }
  if (provenanceType === 'heuristic' && signalState === 'stable') {
    throw new ClientHealthPlanningError(
      'HEURISTIC_STABILITY_FORBIDDEN',
      'heuristic evidence cannot assert a stable outcome'
    );
  }
  const dimensions = input.dimensions;
  if (!dimensions || typeof dimensions !== 'object' || Array.isArray(dimensions)
      || Object.keys(dimensions).length === 0) {
    throw new ClientHealthPlanningError(
      'DIMENSIONS_REQUIRED',
      'dimensions must be a non-empty structured object'
    );
  }
  const evidence = normalizeEvidence(input.evidence);
  const actor = normalizeActor(input);
  const request = normalizeRequestEnvelope(input);
  const semantic = {
    ...identity,
    snapshotId,
    signalState,
    provenanceType,
    dimensions,
    evidence,
    ...actor,
  };
  return Object.freeze({
    kind: 'client_health_signal_snapshot',
    ...semantic,
    ...request,
    evidenceDigest: sha256(stableJson(evidence)),
    semanticFingerprint: sha256(stableJson(semantic)),
    externalActionPermitted: false,
  });
}

function planClientHealthInterventionCommand(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ClientHealthPlanningError('COMMAND_REQUIRED', 'command input is required');
  }
  assertNoForbiddenKeys(input);
  const identity = normalizeIdentity(input, true);
  const action = requiredString(input.action, 'ACTION_INVALID', 'action', 3, 40)
    .toLowerCase();
  if (!ACTIONS.has(action)) {
    throw new ClientHealthPlanningError('ACTION_INVALID', 'action is unsupported');
  }
  const expectedRevision = Number(input.expectedRevision);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new ClientHealthPlanningError(
      'REVISION_INVALID',
      'expectedRevision must be a non-negative safe integer'
    );
  }
  const evidence = normalizeEvidence(input.evidence);
  const actor = normalizeActor(input);
  const request = normalizeRequestEnvelope(input);

  const command = {
    ...identity,
    action,
    expectedRevision,
    evidence,
    ...actor,
    signalSnapshotId: optionalUuid(
      input.signalSnapshotId,
      'SNAPSHOT_ID_INVALID',
      'signalSnapshotId'
    ),
    ownerId: optionalUuid(input.ownerId, 'OWNER_ID_INVALID', 'ownerId'),
    assigneeId: optionalUuid(input.assigneeId, 'ASSIGNEE_ID_INVALID', 'assigneeId'),
    slaDueAt: optionalTimestamp(input.slaDueAt, 'SLA_DUE_AT_INVALID', 'slaDueAt'),
    escalationCode: input.escalationCode === undefined || input.escalationCode === null
      ? null
      : requiredString(
        input.escalationCode,
        'ESCALATION_CODE_INVALID',
        'escalationCode',
        3,
        80
      ).toLowerCase(),
    outcomeState: input.outcomeState === undefined || input.outcomeState === null
      ? null
      : requiredString(
        input.outcomeState,
        'OUTCOME_STATE_INVALID',
        'outcomeState',
        8,
        9
      ).toLowerCase(),
    actionPlan: input.actionPlan ?? null,
  };
  if (command.escalationCode && !CODE_PATTERN.test(command.escalationCode)) {
    throw new ClientHealthPlanningError(
      'ESCALATION_CODE_INVALID',
      'escalationCode must be a stable machine code'
    );
  }

  if (action === 'open_intervention') {
    if (expectedRevision !== 0
        || !command.signalSnapshotId
        || !command.ownerId
        || !command.assigneeId
        || !command.slaDueAt
        || !command.actionPlan
        || typeof command.actionPlan !== 'object'
        || Array.isArray(command.actionPlan)
        || !command.actionPlan.objective
        || !command.actionPlan.action_type
        || !command.actionPlan.success_metric) {
      throw new ClientHealthPlanningError(
        'OPEN_CONTRACT_INVALID',
        'opening requires revision zero, signal, owners, SLA, and a measurable action plan'
      );
    }
    if (Date.parse(command.slaDueAt) <= Date.parse(evidence.observed_at)) {
      throw new ClientHealthPlanningError(
        'SLA_INVALID',
        'slaDueAt must follow the opening evidence'
      );
    }
  } else if (action === 'escalate') {
    if (!command.escalationCode) {
      throw new ClientHealthPlanningError(
        'ESCALATION_CODE_REQUIRED',
        'escalation requires a stable reason code'
      );
    }
  } else if (action === 'record_outcome') {
    if (!OUTCOME_STATES.has(command.outcomeState)) {
      throw new ClientHealthPlanningError(
        'OUTCOME_STATE_INVALID',
        'record_outcome requires improved, unchanged, or worsened'
      );
    }
    if (evidence.source_type !== 'client_outcome_receipt') {
      throw new ClientHealthPlanningError(
        'OUTCOME_EVIDENCE_INVALID',
        'outcome state requires a client_outcome_receipt'
      );
    }
  } else if (command.outcomeState !== null) {
    throw new ClientHealthPlanningError(
      'OUTCOME_STATE_FORBIDDEN',
      'only record_outcome may carry an outcome state'
    );
  }

  const semantic = { ...command };
  return Object.freeze({
    kind: 'client_health_intervention_command',
    ...command,
    ...request,
    evidenceDigest: sha256(stableJson(evidence)),
    semanticFingerprint: sha256(stableJson(semantic)),
    externalActionPermitted: false,
  });
}

module.exports = {
  ClientHealthPlanningError,
  planClientHealthSignalSnapshot,
  planClientHealthInterventionCommand,
  stableJson,
};
