'use strict';

const crypto = require('node:crypto');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST = /^[a-f0-9]{64}$/;
const CODE = /^[a-z][a-z0-9_]{2,79}$/;
const REPORT_TYPES = new Set(['handoff', 'implementation', 'customer_outcome']);
const EXECUTION_STATES = new Set(['unknown', 'healthy', 'degraded', 'failed']);
const CUSTOMER_OUTCOMES = new Set([
  'unknown', 'unproven', 'achieved', 'not_achieved',
]);
const REQUIRED_KPIS = Object.freeze({
  handoff: new Set([
    'closed_won_to_accept_minutes',
    'accepted_to_acknowledged_minutes',
    'evidence_complete_handoff_rate',
  ]),
  implementation: new Set([
    'implementation_completion_rate',
    'onboarding_sla_compliance_rate',
    'exception_resolution_rate',
  ]),
  customer_outcome: new Set([
    'time_to_first_value_days',
    'customer_outcome_receipt_rate',
  ]),
});
const EXPECTED_EVIDENCE = Object.freeze({
  handoff: 'closed_won_handoff_receipt',
  implementation: 'onboarding_workflow_receipt',
  customer_outcome: 'customer_outcome_receipt',
});
const ACTIONS = new Set([
  'create_goal', 'complete_goal', 'create_work', 'accept_work',
  'escalate_work', 'complete_work', 'record_customer_outcome',
  'recommend_decision', 'decide_recommendation',
  'raise_exception', 'resolve_exception',
]);
const TYPES = Object.freeze({
  create_goal: 'goal',
  complete_goal: 'goal',
  create_work: 'work',
  accept_work: 'work',
  escalate_work: 'work',
  complete_work: 'work',
  record_customer_outcome: 'work',
  recommend_decision: 'decision',
  decide_recommendation: 'decision',
  raise_exception: 'exception',
  resolve_exception: 'exception',
});
const ACTOR_TYPES = new Set(['human', 'agent', 'service', 'system']);
const AUTHORITY = new Set(['system', 'operator', 'department_head', 'owner']);
const FORBIDDEN = new Set([
  'send', 'dispatch', 'recipient', 'email', 'phone', 'message',
  'provider', 'providerToken', 'provisionProduction', 'deployProduction',
  'applyMigration', 'charge', 'refund', 'transfer', 'publish',
  'activateWriteAuthority', 'rawCustomer', 'rawPayload', 'customerEmail',
  'clientEmail', 'contactEmail', 'customerPhone', 'clientPhone',
  'customerAddress', 'clientAddress', 'customerName', 'clientName',
  'apiKey', 'secret', 'password', 'messageBody', 'customerMessage',
].map(normalizeKey));
const EVIDENCE_KEYS = new Set(['source_type', 'source_id', 'observed_at']);
const OWNER_ROLES = new Set([
  'owner', 'platform_owner', 'founder', 'admin',
  'client_owner', 'tenant_owner',
]);

class OnboardingDepartmentHeadError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OnboardingDepartmentHeadError';
    this.code = code;
  }
}

function required(value, code, label, min = 1, max = 240) {
  if (typeof value !== 'string') {
    throw new OnboardingDepartmentHeadError(code, `${label} must be a string`);
  }
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) {
    throw new OnboardingDepartmentHeadError(code, `${label} has an invalid length`);
  }
  return normalized;
}

function uuid(value, code, label, optional = false) {
  if (optional && (value === null || value === undefined || value === '')) return null;
  const normalized = required(value, code, label, 36, 36).toLowerCase();
  if (!UUID.test(normalized)) {
    throw new OnboardingDepartmentHeadError(code, `${label} must be a UUID`);
  }
  return normalized;
}

function timestamp(value, code, label, optional = false) {
  if (optional && (value === null || value === undefined || value === '')) return null;
  const normalized = required(value, code, label, 20, 40);
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    throw new OnboardingDepartmentHeadError(code, `${label} must be an ISO timestamp`);
  }
  return new Date(parsed).toISOString();
}

function object(value, code, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length === 0) {
    throw new OnboardingDepartmentHeadError(code, `${label} must be a non-empty object`);
  }
  return value;
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

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function forbiddenKey(key) {
  const normalized = normalizeKey(key);
  return FORBIDDEN.has(normalized)
    || /(email|phone|address|apikey|token|secret|password|recipient|messagebody)$/
      .test(normalized)
    || /^(rawpayload|rawcustomer|customermessage)/.test(normalized);
}

function contained(value, path = 'command') {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((child, index) => contained(child, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenKey(key)) {
      throw new OnboardingDepartmentHeadError(
        'PROHIBITED_ACTION_INPUT',
        `${path}.${key} is outside supervised read-only authority`,
      );
    }
    contained(child, `${path}.${key}`);
  }
}

function evidence(value) {
  const normalized = object(value, 'EVIDENCE_REQUIRED', 'evidence');
  contained(normalized, 'evidence');
  const keys = Object.keys(normalized);
  if (keys.length !== EVIDENCE_KEYS.size
      || keys.some(key => !EVIDENCE_KEYS.has(key))) {
    throw new OnboardingDepartmentHeadError(
      'EVIDENCE_SCHEMA_INVALID',
      'evidence permits only source_type, source_id, and observed_at',
    );
  }
  const sourceType = required(
    normalized.source_type,
    'EVIDENCE_SOURCE_INVALID',
    'evidence.source_type',
    3,
    60,
  );
  const sourceId = required(
    normalized.source_id,
    'EVIDENCE_SOURCE_INVALID',
    'evidence.source_id',
    3,
    240,
  );
  if (!CODE.test(sourceType) || !/^[A-Za-z0-9_./:-]+$/.test(sourceId)) {
    throw new OnboardingDepartmentHeadError(
      'EVIDENCE_SOURCE_INVALID',
      'evidence source must be an opaque machine reference',
    );
  }
  return {
    ...normalized,
    source_type: sourceType,
    source_id: sourceId,
    observed_at: timestamp(
      normalized.observed_at,
      'EVIDENCE_TIME_INVALID',
      'evidence.observed_at',
    ),
  };
}

function planOnboardingCustomerOutcomeReceipt(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new OnboardingDepartmentHeadError(
      'RECEIPT_REQUIRED',
      'canonical customer outcome receipt is required',
    );
  }
  contained(input);
  const verifierUserId = uuid(
    input.verifierUserId,
    'VERIFIER_ID_INVALID',
    'verifierUserId',
  );
  const verifierRole = required(
    input.verifierRole,
    'VERIFIER_ROLE_INVALID',
    'verifierRole',
    5,
    20,
  ).toLowerCase();
  const registeredHeadId = required(
    input.registeredHeadId,
    'HEAD_ID_INVALID',
    'registeredHeadId',
    3,
    160,
  );
  if (!OWNER_ROLES.has(verifierRole)
      || verifierUserId.toLowerCase() === registeredHeadId.toLowerCase()) {
    throw new OnboardingDepartmentHeadError(
      'INDEPENDENT_HUMAN_VERIFIER_REQUIRED',
      'a tenant owner distinct from the Head must verify customer outcome',
    );
  }
  const outcomeState = required(
    input.customerOutcomeState,
    'OUTCOME_STATE_INVALID',
    'customerOutcomeState',
    8,
    12,
  ).toLowerCase();
  const outcomeCode = required(
    input.outcomeCode,
    'OUTCOME_CODE_INVALID',
    'outcomeCode',
    3,
    80,
  ).toLowerCase();
  if (!['achieved', 'not_achieved'].includes(outcomeState)
      || !CODE.test(outcomeCode)) {
    throw new OnboardingDepartmentHeadError(
      'OUTCOME_CONTRACT_INVALID',
      'canonical outcome state or code is invalid',
    );
  }
  const evidenceRef = required(
    input.evidenceRef,
    'EVIDENCE_REF_INVALID',
    'evidenceRef',
    3,
    240,
  );
  if (!/^[A-Za-z0-9_./:-]+$/.test(evidenceRef)) {
    throw new OnboardingDepartmentHeadError(
      'EVIDENCE_REF_INVALID',
      'evidenceRef must be an opaque non-contact reference',
    );
  }
  const evidenceDigest = required(
    input.evidenceDigest,
    'EVIDENCE_DIGEST_INVALID',
    'evidenceDigest',
    64,
    64,
  ).toLowerCase();
  const requestFingerprint = required(
    input.requestFingerprint,
    'REQUEST_FINGERPRINT_INVALID',
    'requestFingerprint',
    64,
    64,
  ).toLowerCase();
  if (!DIGEST.test(evidenceDigest) || !DIGEST.test(requestFingerprint)) {
    throw new OnboardingDepartmentHeadError(
      'DIGEST_INVALID',
      'receipt digests must be SHA-256 values',
    );
  }
  const planned = {
    tenantId: uuid(input.tenantId, 'TENANT_ID_INVALID', 'tenantId'),
    clientTenantId: uuid(
      input.clientTenantId,
      'CLIENT_TENANT_ID_INVALID',
      'clientTenantId',
    ),
    workflowId: uuid(input.workflowId, 'WORKFLOW_ID_INVALID', 'workflowId'),
    receiptId: uuid(input.receiptId, 'RECEIPT_ID_INVALID', 'receiptId'),
    customerOutcomeState: outcomeState,
    outcomeCode,
    measuredAt: timestamp(input.measuredAt, 'MEASURED_AT_INVALID', 'measuredAt'),
    evidenceRef,
    evidenceDigest,
    verifierUserId,
    verifierRole,
    registeredHeadId,
    idempotencyKey: required(
      input.idempotencyKey,
      'IDEMPOTENCY_KEY_INVALID',
      'idempotencyKey',
      8,
      200,
    ),
    requestFingerprint,
  };
  return Object.freeze({
    kind: 'onboarding_customer_outcome_receipt',
    ...planned,
    receiptDigest: sha256(stableJson(planned)),
    headMayVerify: false,
  });
}

function actor(input) {
  const type = required(input.actorType, 'ACTOR_INVALID', 'actorType', 5, 7)
    .toLowerCase();
  const authorityTier = required(
    input.authorityTier,
    'AUTHORITY_INVALID',
    'authorityTier',
    5,
    20,
  ).toLowerCase();
  if (!ACTOR_TYPES.has(type) || !AUTHORITY.has(authorityTier)) {
    throw new OnboardingDepartmentHeadError(
      'ACTOR_AUTHORITY_INVALID',
      'actor type or authority is unsupported',
    );
  }
  let id = null;
  if (type === 'human') {
    id = uuid(input.actorId, 'ACTOR_ID_INVALID', 'actorId');
    if (!['operator', 'owner'].includes(authorityTier)) {
      throw new OnboardingDepartmentHeadError(
        'HUMAN_AUTHORITY_INVALID',
        'human authority must be operator or owner',
      );
    }
  } else if (type === 'agent') {
    id = required(input.actorId, 'ACTOR_ID_INVALID', 'actorId', 3, 160);
    if (authorityTier !== 'department_head') {
      throw new OnboardingDepartmentHeadError(
        'AGENT_AUTHORITY_INVALID',
        'the registered Head requires department_head authority',
      );
    }
  } else if (type === 'service') {
    id = required(input.actorId, 'ACTOR_ID_INVALID', 'actorId', 2, 160);
    if (authorityTier !== 'system') {
      throw new OnboardingDepartmentHeadError(
        'SERVICE_AUTHORITY_INVALID',
        'services require system authority',
      );
    }
  } else if (
    (input.actorId !== null && input.actorId !== undefined && input.actorId !== '')
    || authorityTier !== 'system'
  ) {
    throw new OnboardingDepartmentHeadError(
      'SYSTEM_ACTOR_INVALID',
      'system actors cannot claim an id or elevated authority',
    );
  }
  return { actorType: type, actorId: id, authorityTier };
}

function base(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new OnboardingDepartmentHeadError('COMMAND_REQUIRED', 'command is required');
  }
  contained(input);
  const revision = Number(input.expectedControlRevision);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new OnboardingDepartmentHeadError(
      'CONTROL_REVISION_INVALID',
      'expectedControlRevision must be a non-negative safe integer',
    );
  }
  if (input.featureGateEnabled !== true) {
    throw new OnboardingDepartmentHeadError(
      'FEATURE_GATE_DISABLED',
      'featureGateEnabled must be explicitly true',
    );
  }
  const fingerprint = required(
    input.requestFingerprint,
    'REQUEST_FINGERPRINT_INVALID',
    'requestFingerprint',
    64,
    64,
  ).toLowerCase();
  if (!DIGEST.test(fingerprint)) {
    throw new OnboardingDepartmentHeadError(
      'REQUEST_FINGERPRINT_INVALID',
      'requestFingerprint must be a SHA-256 digest',
    );
  }
  return {
    tenantId: uuid(input.tenantId, 'TENANT_ID_INVALID', 'tenantId'),
    clientTenantId: uuid(
      input.clientTenantId,
      'CLIENT_TENANT_ID_INVALID',
      'clientTenantId',
    ),
    expectedControlRevision: revision,
    featureGateEnabled: true,
    idempotencyKey: required(
      input.idempotencyKey,
      'IDEMPOTENCY_KEY_INVALID',
      'idempotencyKey',
      8,
      200,
    ),
    requestFingerprint: fingerprint,
  };
}

function validatedKpis(kpis, reportType, requireVerified) {
  if (!Array.isArray(kpis) || kpis.length === 0) {
    throw new OnboardingDepartmentHeadError(
      'KPI_RESULTS_REQUIRED',
      'kpiResults must contain at least one KPI',
    );
  }
  const keys = new Set();
  for (const result of kpis) {
    object(result, 'KPI_RESULT_INVALID', 'KPI result');
    const key = required(result.kpi_key, 'KPI_KEY_INVALID', 'kpi_key', 3, 80);
    if (!CODE.test(key) || keys.has(key)) {
      throw new OnboardingDepartmentHeadError(
        'KPI_KEY_INVALID',
        'KPI keys must be unique machine codes',
      );
    }
    keys.add(key);
    if (!['verified', 'unverified', 'unknown'].includes(result.verification_state)) {
      throw new OnboardingDepartmentHeadError(
        'KPI_VERIFICATION_INVALID',
        'KPI verification state is invalid',
      );
    }
    if (requireVerified && (
      result.verification_state !== 'verified'
      || typeof result.evidence_ref !== 'string'
      || result.evidence_ref.trim().length < 3
    )) {
      throw new OnboardingDepartmentHeadError(
        'FALSE_OUTCOME_FORBIDDEN',
        'verified customer outcomes require evidence for every KPI',
      );
    }
  }
  if (requireVerified) {
    for (const requiredKey of REQUIRED_KPIS[reportType]) {
      if (!keys.has(requiredKey)) {
        throw new OnboardingDepartmentHeadError(
          'FALSE_OUTCOME_FORBIDDEN',
          `verified ${reportType} reports require ${requiredKey}`,
        );
      }
    }
  }
  return kpis;
}

function planOnboardingHeadReport(input = {}) {
  const common = base(input);
  const reportType = required(
    input.reportType,
    'REPORT_TYPE_INVALID',
    'reportType',
    7,
    20,
  ).toLowerCase();
  const executionState = required(
    input.executionHealthState,
    'EXECUTION_STATE_INVALID',
    'executionHealthState',
    6,
    8,
  ).toLowerCase();
  const outcomeState = required(
    input.customerOutcomeState,
    'OUTCOME_STATE_INVALID',
    'customerOutcomeState',
    7,
    12,
  ).toLowerCase();
  if (!REPORT_TYPES.has(reportType)
      || !EXECUTION_STATES.has(executionState)
      || !CUSTOMER_OUTCOMES.has(outcomeState)) {
    throw new OnboardingDepartmentHeadError(
      'REPORT_CONTRACT_INVALID',
      'report type or state is unsupported',
    );
  }
  const outcomeVerified = input.outcomeVerified === true;
  const isProvenOutcome = ['achieved', 'not_achieved'].includes(outcomeState);
  if (outcomeVerified !== isProvenOutcome) {
    throw new OnboardingDepartmentHeadError(
      'OUTCOME_VERIFICATION_INVALID',
      'only achieved/not_achieved customer outcomes can be verified',
    );
  }
  const ev = evidence(input.evidence);
  if (ev.source_type !== EXPECTED_EVIDENCE[reportType]) {
    throw new OnboardingDepartmentHeadError(
      'AUTHORITATIVE_EVIDENCE_REQUIRED',
      `${reportType} requires ${EXPECTED_EVIDENCE[reportType]}`,
    );
  }
  const customerOutcomeReceiptId = uuid(
    input.customerOutcomeReceiptId,
    'CUSTOMER_OUTCOME_RECEIPT_ID_INVALID',
    'customerOutcomeReceiptId',
    true,
  );
  if (isProvenOutcome && !customerOutcomeReceiptId) {
    throw new OnboardingDepartmentHeadError(
      'CANONICAL_OUTCOME_RECEIPT_REQUIRED',
      'verified customer outcome requires an independent canonical receipt',
    );
  }
  if (!isProvenOutcome && customerOutcomeReceiptId) {
    throw new OnboardingDepartmentHeadError(
      'OUTCOME_RECEIPT_FORBIDDEN',
      'unproven reports cannot carry a customer outcome receipt',
    );
  }
  const workflowId = uuid(
    input.workflowId,
    'WORKFLOW_ID_INVALID',
    'workflowId',
    reportType === 'handoff',
  );
  if (reportType !== 'handoff' && !workflowId) {
    throw new OnboardingDepartmentHeadError(
      'WORKFLOW_ID_REQUIRED',
      'implementation and outcome reports require a workflow',
    );
  }
  const kpis = validatedKpis(
    input.kpiResults,
    reportType,
    isProvenOutcome,
  );
  const planned = {
    ...common,
    reportId: uuid(input.reportId, 'REPORT_ID_INVALID', 'reportId'),
    handoffId: uuid(input.handoffId, 'HANDOFF_ID_INVALID', 'handoffId'),
    workflowId,
    customerOutcomeReceiptId,
    reportType,
    periodStart: timestamp(input.periodStart, 'PERIOD_INVALID', 'periodStart'),
    periodEnd: timestamp(input.periodEnd, 'PERIOD_INVALID', 'periodEnd'),
    executionHealthState: executionState,
    customerOutcomeState: outcomeState,
    outcomeVerified,
    kpiResults: kpis,
    reportBody: object(input.reportBody, 'REPORT_BODY_INVALID', 'reportBody'),
    evidence: ev,
    ...actor(input),
  };
  if (Date.parse(planned.periodEnd) <= Date.parse(planned.periodStart)) {
    throw new OnboardingDepartmentHeadError(
      'PERIOD_INVALID',
      'periodEnd must follow periodStart',
    );
  }
  const semantics = { ...planned };
  return Object.freeze({
    kind: 'onboarding_head_report',
    ...planned,
    evidenceDigest: sha256(stableJson(ev)),
    semanticFingerprint: sha256(stableJson(semantics)),
    operationalActionPermitted: false,
  });
}

function planOnboardingHeadCaseCommand(input = {}) {
  const common = base(input);
  const action = required(input.action, 'ACTION_INVALID', 'action', 3, 40)
    .toLowerCase();
  if (!ACTIONS.has(action)) {
    throw new OnboardingDepartmentHeadError('ACTION_INVALID', 'action is unsupported');
  }
  const expectedRevision = Number(input.expectedRevision);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new OnboardingDepartmentHeadError(
      'REVISION_INVALID',
      'expectedRevision must be a non-negative safe integer',
    );
  }
  const normalized = {
    ...common,
    caseId: uuid(input.caseId, 'CASE_ID_INVALID', 'caseId'),
    action,
    caseType: TYPES[action],
    expectedRevision,
    sourceReportId: uuid(
      input.sourceReportId,
      'SOURCE_REPORT_ID_INVALID',
      'sourceReportId',
      true,
    ),
    ownerId: uuid(input.ownerId, 'OWNER_ID_INVALID', 'ownerId', true),
    assigneeId: uuid(input.assigneeId, 'ASSIGNEE_ID_INVALID', 'assigneeId', true),
    slaDueAt: timestamp(input.slaDueAt, 'SLA_DUE_INVALID', 'slaDueAt', true),
    title: input.title === null || input.title === undefined
      ? null
      : required(input.title, 'TITLE_INVALID', 'title', 3, 240),
    contract: input.contract ?? null,
    escalationCode: input.escalationCode === null
      || input.escalationCode === undefined
      ? null
      : required(
        input.escalationCode,
        'ESCALATION_CODE_INVALID',
        'escalationCode',
        3,
        80,
      ).toLowerCase(),
    customerOutcomeState: input.customerOutcomeState === null
      || input.customerOutcomeState === undefined
      ? null
      : required(
        input.customerOutcomeState,
        'OUTCOME_STATE_INVALID',
        'customerOutcomeState',
        8,
        12,
      ).toLowerCase(),
    customerOutcomeReceiptId: uuid(
      input.customerOutcomeReceiptId,
      'CUSTOMER_OUTCOME_RECEIPT_ID_INVALID',
      'customerOutcomeReceiptId',
      true,
    ),
    decision: input.decision === null || input.decision === undefined
      ? null
      : required(input.decision, 'DECISION_INVALID', 'decision', 8, 8)
        .toLowerCase(),
    evidence: evidence(input.evidence),
    ...actor(input),
  };

  if (['create_goal', 'create_work', 'recommend_decision', 'raise_exception']
    .includes(action)) {
    if (expectedRevision !== 0 || !normalized.ownerId || !normalized.slaDueAt
        || !normalized.title
        || !normalized.contract
        || typeof normalized.contract !== 'object'
        || Array.isArray(normalized.contract)
        || Object.keys(normalized.contract).length === 0) {
      throw new OnboardingDepartmentHeadError(
        'CASE_CREATION_INVALID',
        'creation requires revision zero, owner, SLA, title, and contract',
      );
    }
    if (action === 'create_work' && !normalized.assigneeId) {
      throw new OnboardingDepartmentHeadError(
        'ASSIGNEE_REQUIRED',
        'work creation requires an assignee',
      );
    }
    if (normalized.actorType === 'human'
        && normalized.authorityTier !== 'owner') {
      throw new OnboardingDepartmentHeadError(
        'ACTION_AUTHORITY_DENIED',
        'human case creation requires owner authority',
      );
    }
  }
  if (action === 'escalate_work'
      && (!normalized.escalationCode || !CODE.test(normalized.escalationCode))) {
    throw new OnboardingDepartmentHeadError(
      'ESCALATION_CODE_REQUIRED',
      'escalation requires a stable machine code',
    );
  }
  if (['complete_goal', 'record_customer_outcome'].includes(action)) {
    if (!['achieved', 'not_achieved'].includes(normalized.customerOutcomeState)
        || normalized.evidence.source_type !== 'customer_outcome_receipt'
        || !normalized.customerOutcomeReceiptId) {
      throw new OnboardingDepartmentHeadError(
        'CUSTOMER_OUTCOME_EVIDENCE_REQUIRED',
        'customer outcomes require an independent canonical receipt',
      );
    }
    if (normalized.actorType === 'human'
        && normalized.authorityTier !== 'owner') {
      throw new OnboardingDepartmentHeadError(
        'ACTION_AUTHORITY_DENIED',
        'human customer outcome recording requires owner authority',
      );
    }
  } else if (
    normalized.customerOutcomeState !== null
    || normalized.customerOutcomeReceiptId !== null
  ) {
    throw new OnboardingDepartmentHeadError(
      'CUSTOMER_OUTCOME_FORBIDDEN',
      'completion cannot carry a customer outcome',
    );
  }
  if (action === 'decide_recommendation') {
    if (!['approved', 'rejected'].includes(normalized.decision)
        || normalized.actorType !== 'human'
        || normalized.authorityTier !== 'owner') {
      throw new OnboardingDepartmentHeadError(
        'HUMAN_DECISION_REQUIRED',
        'only an owner-authorized human can decide a recommendation',
      );
    }
  } else if (normalized.decision !== null) {
    throw new OnboardingDepartmentHeadError(
      'DECISION_FORBIDDEN',
      'this action cannot carry a decision',
    );
  }
  const semantics = { ...normalized };
  return Object.freeze({
    kind: 'onboarding_head_case_command',
    ...normalized,
    evidenceDigest: sha256(stableJson(normalized.evidence)),
    semanticFingerprint: sha256(stableJson(semantics)),
    operationalActionPermitted: false,
  });
}

module.exports = {
  OnboardingDepartmentHeadError,
  planOnboardingCustomerOutcomeReceipt,
  planOnboardingHeadReport,
  planOnboardingHeadCaseCommand,
  stableJson,
};
