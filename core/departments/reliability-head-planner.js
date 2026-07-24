'use strict';

const crypto = require('node:crypto');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const CODE_RE = /^[a-z][a-z0-9_]{2,79}$/;
const REPORT_TYPES = new Set(['reliability', 'security', 'agent_operations']);
const EXECUTION_HEALTH = new Set(['unknown', 'healthy', 'degraded', 'failed']);
const OUTCOME_HEALTH = new Set(['unknown', 'unproven', 'healthy', 'degraded', 'critical']);
const REQUIRED_HEALTHY_KPIS = Object.freeze({
  reliability: new Set([
    'incident_detection_to_ack_minutes',
    'verified_recovery_rate',
    'sla_compliance_rate',
  ]),
  security: new Set([
    'tenant_isolation_gate_pass_rate',
    'audit_evidence_completeness',
  ]),
  agent_operations: new Set([
    'agent_business_outcome_rate',
    'audit_evidence_completeness',
  ]),
});
const CASE_ACTIONS = new Set([
  'create_goal',
  'complete_goal',
  'create_work',
  'accept_work',
  'escalate_work',
  'complete_work',
  'record_work_outcome',
  'recommend_decision',
  'decide_recommendation',
  'raise_exception',
  'resolve_exception',
]);
const CASE_TYPES = Object.freeze({
  create_goal: 'goal',
  complete_goal: 'goal',
  create_work: 'work',
  accept_work: 'work',
  escalate_work: 'work',
  complete_work: 'work',
  record_work_outcome: 'work',
  recommend_decision: 'decision',
  decide_recommendation: 'decision',
  raise_exception: 'exception',
  resolve_exception: 'exception',
});
const OUTCOME_STATES = new Set(['achieved', 'not_achieved']);
const DECISIONS = new Set(['approved', 'rejected']);
const ACTOR_TYPES = new Set(['human', 'agent', 'service', 'system']);
const AUTHORITY_TIERS = new Set(['system', 'operator', 'department_head', 'owner']);
const FORBIDDEN_KEYS = new Set([
  'deployProduction',
  'applyMigration',
  'sendCustomerMessage',
  'sendEmail',
  'sendSms',
  'placeCall',
  'providerToken',
  'chargeCustomer',
  'refundCustomer',
  'publishContent',
  'activateWriteAuthority',
]);

class ReliabilityHeadPlanningError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ReliabilityHeadPlanningError';
    this.code = code;
  }
}

function text(value, code, label, minimum = 1, maximum = 240) {
  const normalized = String(value || '').trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new ReliabilityHeadPlanningError(code, `${label} has an invalid length`);
  }
  return normalized;
}

function uuid(value, code, label) {
  const normalized = text(value, code, label, 36, 36).toLowerCase();
  if (!UUID_RE.test(normalized)) {
    throw new ReliabilityHeadPlanningError(code, `${label} must be a UUID`);
  }
  return normalized;
}

function optionalUuid(value, code, label) {
  if (value === undefined || value === null || value === '') return null;
  return uuid(value, code, label);
}

function timestamp(value, code, label) {
  const normalized = text(value, code, label, 20, 40);
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    throw new ReliabilityHeadPlanningError(code, `${label} must be an ISO timestamp`);
  }
  return new Date(parsed).toISOString();
}

function optionalTimestamp(value, code, label) {
  if (value === undefined || value === null || value === '') return null;
  return timestamp(value, code, label);
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

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function object(value, code, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length === 0) {
    throw new ReliabilityHeadPlanningError(code, `${label} must be a non-empty object`);
  }
  return value;
}

function evidence(value) {
  const normalized = object(value, 'EVIDENCE_REQUIRED', 'evidence');
  return {
    ...normalized,
    source_type: text(
      normalized.source_type,
      'EVIDENCE_SOURCE_TYPE_INVALID',
      'evidence.source_type',
      3,
      60
    ),
    source_id: text(
      normalized.source_id,
      'EVIDENCE_SOURCE_ID_INVALID',
      'evidence.source_id',
      3,
      240
    ),
    observed_at: timestamp(
      normalized.observed_at,
      'EVIDENCE_TIME_INVALID',
      'evidence.observed_at'
    ),
  };
}

function assertContained(input) {
  for (const key of FORBIDDEN_KEYS) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      throw new ReliabilityHeadPlanningError(
        'PROHIBITED_ACTION',
        `Reliability Head planning cannot contain ${key}`
      );
    }
  }
}

function actor(input) {
  const actorType = text(input.actorType, 'ACTOR_TYPE_INVALID', 'actorType', 5, 7)
    .toLowerCase();
  const authorityTier = text(
    input.authorityTier,
    'AUTHORITY_TIER_INVALID',
    'authorityTier',
    5,
    20
  ).toLowerCase();
  if (!ACTOR_TYPES.has(actorType) || !AUTHORITY_TIERS.has(authorityTier)) {
    throw new ReliabilityHeadPlanningError(
      'ACTOR_AUTHORITY_INVALID',
      'actor type or authority tier is unsupported'
    );
  }
  let actorId = null;
  if (actorType === 'human') {
    actorId = uuid(input.actorId, 'ACTOR_ID_INVALID', 'actorId');
    if (!['operator', 'owner'].includes(authorityTier)) {
      throw new ReliabilityHeadPlanningError(
        'HUMAN_AUTHORITY_INVALID',
        'human commands require operator or owner authority'
      );
    }
  } else if (actorType === 'agent') {
    actorId = text(input.actorId, 'ACTOR_ID_INVALID', 'actorId', 3, 160);
    if (authorityTier !== 'department_head') {
      throw new ReliabilityHeadPlanningError(
        'AGENT_AUTHORITY_INVALID',
        'the Reliability Head agent requires department_head authority'
      );
    }
  } else if (actorType === 'service') {
    actorId = text(input.actorId, 'ACTOR_ID_INVALID', 'actorId', 2, 160);
    if (authorityTier !== 'system') {
      throw new ReliabilityHeadPlanningError(
        'SERVICE_AUTHORITY_INVALID',
        'service commands require system authority'
      );
    }
  } else if (
    (input.actorId !== undefined && input.actorId !== null && input.actorId !== '')
    || authorityTier !== 'system'
  ) {
    throw new ReliabilityHeadPlanningError(
      'SYSTEM_ACTOR_INVALID',
      'system commands cannot claim an actor id or elevated authority'
    );
  }
  return { actorType, actorId, authorityTier };
}

function envelope(input) {
  const expectedControlRevision = Number(input.expectedControlRevision);
  if (!Number.isSafeInteger(expectedControlRevision)
      || expectedControlRevision < 0) {
    throw new ReliabilityHeadPlanningError(
      'CONTROL_REVISION_INVALID',
      'expectedControlRevision must be a non-negative safe integer'
    );
  }
  if (input.featureGateEnabled !== true) {
    throw new ReliabilityHeadPlanningError(
      'FEATURE_GATE_DISABLED',
      'featureGateEnabled must be explicitly true'
    );
  }
  const requestFingerprint = text(
    input.requestFingerprint,
    'REQUEST_FINGERPRINT_INVALID',
    'requestFingerprint',
    64,
    64
  ).toLowerCase();
  if (!DIGEST_RE.test(requestFingerprint)) {
    throw new ReliabilityHeadPlanningError(
      'REQUEST_FINGERPRINT_INVALID',
      'requestFingerprint must be a lowercase SHA-256 digest'
    );
  }
  return {
    tenantId: uuid(input.tenantId, 'TENANT_ID_INVALID', 'tenantId'),
    expectedControlRevision,
    featureGateEnabled: true,
    idempotencyKey: text(
      input.idempotencyKey,
      'IDEMPOTENCY_KEY_INVALID',
      'idempotencyKey',
      8,
      200
    ),
    requestFingerprint,
  };
}

function validateKpis(kpis, reportType, outcomeHealthState, outcomeVerified) {
  if (!Array.isArray(kpis) || kpis.length === 0) {
    throw new ReliabilityHeadPlanningError(
      'KPI_RESULTS_REQUIRED',
      'kpiResults must contain at least one KPI'
    );
  }
  const keys = new Set();
  for (const result of kpis) {
    object(result, 'KPI_RESULT_INVALID', 'kpi result');
    const kpiKey = text(result.kpi_key, 'KPI_KEY_INVALID', 'kpi_key', 3, 80);
    if (!CODE_RE.test(kpiKey) || keys.has(kpiKey)) {
      throw new ReliabilityHeadPlanningError(
        'KPI_KEY_INVALID',
        'KPI keys must be unique machine codes'
      );
    }
    keys.add(kpiKey);
    if (!['verified', 'unverified', 'unknown'].includes(result.verification_state)) {
      throw new ReliabilityHeadPlanningError(
        'KPI_VERIFICATION_INVALID',
        'KPI verification state is invalid'
      );
    }
    if (outcomeHealthState === 'healthy' && (
      result.verification_state !== 'verified'
      || !text(result.evidence_ref, 'KPI_EVIDENCE_REQUIRED', 'evidence_ref', 3, 240)
    )) {
      throw new ReliabilityHeadPlanningError(
        'FALSE_GREEN_FORBIDDEN',
        'healthy outcome status requires verified evidence for every KPI'
      );
    }
  }
  if (outcomeHealthState === 'healthy' && outcomeVerified !== true) {
    throw new ReliabilityHeadPlanningError(
      'FALSE_GREEN_FORBIDDEN',
      'healthy outcome status requires outcomeVerified=true'
    );
  }
  if (outcomeHealthState === 'healthy') {
    for (const requiredKey of REQUIRED_HEALTHY_KPIS[reportType]) {
      if (!keys.has(requiredKey)) {
        throw new ReliabilityHeadPlanningError(
          'FALSE_GREEN_FORBIDDEN',
          `healthy ${reportType} status requires ${requiredKey}`
        );
      }
    }
  }
}

function planReliabilityHeadReport(input = {}) {
  assertContained(input);
  const common = envelope(input);
  const reportType = text(
    input.reportType,
    'REPORT_TYPE_INVALID',
    'reportType',
    8,
    20
  ).toLowerCase();
  const executionHealthState = text(
    input.executionHealthState,
    'EXECUTION_HEALTH_INVALID',
    'executionHealthState',
    6,
    8
  ).toLowerCase();
  const outcomeHealthState = text(
    input.outcomeHealthState,
    'OUTCOME_HEALTH_INVALID',
    'outcomeHealthState',
    7,
    10
  ).toLowerCase();
  if (!REPORT_TYPES.has(reportType)
      || !EXECUTION_HEALTH.has(executionHealthState)
      || !OUTCOME_HEALTH.has(outcomeHealthState)) {
    throw new ReliabilityHeadPlanningError(
      'REPORT_CONTRACT_INVALID',
      'report type or health state is unsupported'
    );
  }
  const kpiResults = input.kpiResults;
  validateKpis(
    kpiResults,
    reportType,
    outcomeHealthState,
    input.outcomeVerified
  );
  const acceptedReport = {
    ...common,
    reportId: uuid(input.reportId, 'REPORT_ID_INVALID', 'reportId'),
    reportType,
    periodStart: timestamp(input.periodStart, 'PERIOD_START_INVALID', 'periodStart'),
    periodEnd: timestamp(input.periodEnd, 'PERIOD_END_INVALID', 'periodEnd'),
    executionHealthState,
    outcomeHealthState,
    outcomeVerified: input.outcomeVerified === true,
    kpiResults,
    reportBody: object(input.reportBody, 'REPORT_BODY_REQUIRED', 'reportBody'),
    evidence: evidence(input.evidence),
    ...actor(input),
  };
  if (Date.parse(acceptedReport.periodEnd) <= Date.parse(acceptedReport.periodStart)) {
    throw new ReliabilityHeadPlanningError(
      'REPORT_PERIOD_INVALID',
      'periodEnd must follow periodStart'
    );
  }
  const semantic = { ...acceptedReport };
  return Object.freeze({
    kind: 'reliability_head_report',
    ...acceptedReport,
    evidenceDigest: digest(stableJson(acceptedReport.evidence)),
    semanticFingerprint: digest(stableJson(semantic)),
    operationalActionPermitted: false,
  });
}

function planReliabilityHeadCaseCommand(input = {}) {
  assertContained(input);
  const common = envelope(input);
  const action = text(input.action, 'ACTION_INVALID', 'action', 3, 40).toLowerCase();
  if (!CASE_ACTIONS.has(action)) {
    throw new ReliabilityHeadPlanningError('ACTION_INVALID', 'action is unsupported');
  }
  const expectedRevision = Number(input.expectedRevision);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new ReliabilityHeadPlanningError(
      'REVISION_INVALID',
      'expectedRevision must be a non-negative safe integer'
    );
  }
  const normalized = {
    ...common,
    caseId: uuid(input.caseId, 'CASE_ID_INVALID', 'caseId'),
    action,
    caseType: CASE_TYPES[action],
    expectedRevision,
    sourceReportId: optionalUuid(
      input.sourceReportId,
      'SOURCE_REPORT_ID_INVALID',
      'sourceReportId'
    ),
    ownerId: optionalUuid(input.ownerId, 'OWNER_ID_INVALID', 'ownerId'),
    assigneeId: optionalUuid(input.assigneeId, 'ASSIGNEE_ID_INVALID', 'assigneeId'),
    slaDueAt: optionalTimestamp(input.slaDueAt, 'SLA_DUE_INVALID', 'slaDueAt'),
    title: input.title === undefined || input.title === null
      ? null
      : text(input.title, 'TITLE_INVALID', 'title', 3, 240),
    contract: input.contract ?? null,
    escalationCode: input.escalationCode === undefined
      || input.escalationCode === null
      ? null
      : text(
        input.escalationCode,
        'ESCALATION_CODE_INVALID',
        'escalationCode',
        3,
        80
      ).toLowerCase(),
    outcomeState: input.outcomeState === undefined || input.outcomeState === null
      ? null
      : text(input.outcomeState, 'OUTCOME_STATE_INVALID', 'outcomeState', 8, 12)
        .toLowerCase(),
    decision: input.decision === undefined || input.decision === null
      ? null
      : text(input.decision, 'DECISION_INVALID', 'decision', 8, 8).toLowerCase(),
    evidence: evidence(input.evidence),
    ...actor(input),
  };

  if (action.startsWith('create_') || action === 'recommend_decision'
      || action === 'raise_exception') {
    if (expectedRevision !== 0 || !normalized.ownerId || !normalized.slaDueAt
        || !normalized.title
        || !normalized.contract
        || typeof normalized.contract !== 'object'
        || Array.isArray(normalized.contract)
        || Object.keys(normalized.contract).length === 0) {
      throw new ReliabilityHeadPlanningError(
        'CASE_CREATION_INVALID',
        'creation requires revision zero, owner, SLA, title, and contract'
      );
    }
    if (action === 'create_work' && !normalized.assigneeId) {
      throw new ReliabilityHeadPlanningError(
        'ASSIGNEE_REQUIRED',
        'work creation requires an assignee'
      );
    }
    if (normalized.actorType === 'human'
        && normalized.authorityTier !== 'owner') {
      throw new ReliabilityHeadPlanningError(
        'ACTION_AUTHORITY_DENIED',
        'human case creation requires owner authority'
      );
    }
  }
  if (action === 'escalate_work') {
    if (!normalized.escalationCode || !CODE_RE.test(normalized.escalationCode)) {
      throw new ReliabilityHeadPlanningError(
        'ESCALATION_CODE_REQUIRED',
        'work escalation requires a stable machine code'
      );
    }
  }
  if (['record_work_outcome', 'complete_goal'].includes(action)) {
    if (normalized.actorType === 'human'
        && normalized.authorityTier !== 'owner') {
      throw new ReliabilityHeadPlanningError(
        'ACTION_AUTHORITY_DENIED',
        'human outcome recording requires owner authority'
      );
    }
    if (!OUTCOME_STATES.has(normalized.outcomeState)
        || normalized.evidence.source_type !== 'business_outcome_receipt') {
      throw new ReliabilityHeadPlanningError(
        'OUTCOME_EVIDENCE_REQUIRED',
        'outcome changes require a business_outcome_receipt'
      );
    }
  } else if (normalized.outcomeState !== null) {
    throw new ReliabilityHeadPlanningError(
      'OUTCOME_STATE_FORBIDDEN',
      'this action cannot carry an outcome state'
    );
  }
  if (action === 'decide_recommendation') {
    if (!DECISIONS.has(normalized.decision)
        || normalized.actorType !== 'human'
        || normalized.authorityTier !== 'owner') {
      throw new ReliabilityHeadPlanningError(
        'HUMAN_DECISION_REQUIRED',
        'recommendations can only be decided by an owner-authorized human'
      );
    }
  } else if (normalized.decision !== null) {
    throw new ReliabilityHeadPlanningError(
      'DECISION_FORBIDDEN',
      'this action cannot carry a decision'
    );
  }

  const semantic = { ...normalized };
  return Object.freeze({
    kind: 'reliability_head_case_command',
    ...normalized,
    evidenceDigest: digest(stableJson(normalized.evidence)),
    semanticFingerprint: digest(stableJson(semantic)),
    operationalActionPermitted: false,
  });
}

module.exports = {
  ReliabilityHeadPlanningError,
  planReliabilityHeadReport,
  planReliabilityHeadCaseCommand,
  stableJson,
};
