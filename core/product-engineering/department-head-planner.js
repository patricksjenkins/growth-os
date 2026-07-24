'use strict';

const crypto = require('node:crypto');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST = /^[a-f0-9]{64}$/;
const CODE = /^[a-z][a-z0-9_]{2,79}$/;
const REPORT_TYPES = new Set([
  'reliability_quality', 'change_throughput', 'regression_isolation',
  'incident_rollback', 'accessibility_security', 'product_outcome',
]);
const PRODUCT_SCOPES = new Set([
  'web', 'mobile', 'backend', 'data', 'agents', 'platform', 'portfolio',
]);
const EXECUTION_STATES = new Set(['unknown', 'healthy', 'degraded', 'failed']);
const PRODUCT_OUTCOMES = new Set([
  'unknown', 'unproven', 'achieved', 'not_achieved',
]);
const REQUIRED_KPIS = Object.freeze({
  reliability_quality: new Set([
    'reliability_quality_pass_rate',
  ]),
  change_throughput: new Set([
    'change_lead_time_hours',
    'change_throughput_rate',
  ]),
  regression_isolation: new Set([
    'regression_escape_rate',
    'tenant_isolation_gate_pass_rate',
  ]),
  incident_rollback: new Set([
    'incident_escape_rate',
    'rollback_readiness_rate',
  ]),
  accessibility_security: new Set([
    'accessibility_debt_count',
    'security_debt_count',
  ]),
  product_outcome: new Set([
    'product_outcome_achievement_rate',
  ]),
});
const REQUIRED_SOURCES = Object.freeze({
  reliability_quality: ['automated_test_run'],
  change_throughput: ['deployment_readiness_check'],
  regression_isolation: ['automated_test_run', 'tenant_isolation_gate'],
  incident_rollback: ['rollback_drill'],
  accessibility_security: ['accessibility_audit', 'security_scan'],
  product_outcome: ['product_outcome_receipt'],
});
const EVIDENCE_SOURCE_TYPES = new Set([
  'automated_test_run', 'tenant_isolation_gate', 'security_scan',
  'accessibility_audit', 'deployment_readiness_check', 'rollback_drill',
  'incident_postmortem', 'product_outcome_receipt',
]);
const ACTIONS = new Set([
  'create_goal', 'complete_goal', 'create_work', 'accept_work',
  'escalate_work', 'complete_work', 'record_product_outcome',
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
  record_product_outcome: 'work',
  recommend_decision: 'decision',
  decide_recommendation: 'decision',
  raise_exception: 'exception',
  resolve_exception: 'exception',
});
const ACTOR_TYPES = new Set(['human', 'agent', 'service', 'system']);
const AUTHORITY = new Set(['system', 'operator', 'department_head', 'owner']);
const FORBIDDEN = new Set([
  'send', 'dispatch', 'recipient', 'email', 'phone', 'message',
  'provider', 'provider_token', 'merge_code', 'merge_pull_request',
  'deploy', 'deploy_production', 'apply_migration', 'activate_feature',
  'release_test_flight', 'release_app_store', 'charge', 'refund', 'transfer',
  'change_pricing', 'change_legal_policy', 'publish',
  'activate_write_authority', 'raw_customer', 'raw_payload', 'credential',
  'credentials', 'secret', 'token', 'customer_email', 'customer_phone',
]);

class ProductEngineeringHeadError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProductEngineeringHeadError';
    this.code = code;
  }
}

function required(value, code, label, min = 1, max = 240) {
  if (typeof value !== 'string') {
    throw new ProductEngineeringHeadError(code, `${label} must be a string`);
  }
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) {
    throw new ProductEngineeringHeadError(code, `${label} has an invalid length`);
  }
  return normalized;
}

function uuid(value, code, label, optional = false) {
  if (optional && (value === null || value === undefined || value === '')) return null;
  const normalized = required(value, code, label, 36, 36).toLowerCase();
  if (!UUID.test(normalized)) {
    throw new ProductEngineeringHeadError(code, `${label} must be a UUID`);
  }
  return normalized;
}

function timestamp(value, code, label, optional = false) {
  if (optional && (value === null || value === undefined || value === '')) return null;
  const normalized = required(value, code, label, 20, 40);
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    throw new ProductEngineeringHeadError(code, `${label} must be an ISO timestamp`);
  }
  return new Date(parsed).toISOString();
}

function object(value, code, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length === 0) {
    throw new ProductEngineeringHeadError(code, `${label} must be a non-empty object`);
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

function normalizedMetadataKey(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function contained(value, path = 'command') {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((child, index) => contained(child, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN.has(normalizedMetadataKey(key))) {
      throw new ProductEngineeringHeadError(
        'PROHIBITED_ACTION_INPUT',
        `${path}.${key} is outside supervised read-only authority`,
      );
    }
    contained(child, `${path}.${key}`);
  }
}

function strictShape(value, allowed, requiredKeys, label) {
  const keys = Object.keys(value);
  for (const key of keys) {
    if (key !== normalizedMetadataKey(key) || !allowed.has(key)) {
      throw new ProductEngineeringHeadError(
        'METADATA_SHAPE_INVALID',
        `${label}.${key} is not a documented metadata field`,
      );
    }
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(value, key)) {
      throw new ProductEngineeringHeadError(
        'METADATA_SHAPE_INVALID',
        `${label}.${key} is required`,
      );
    }
  }
}

function evidence(value, extraFields = []) {
  const normalized = object(value, 'EVIDENCE_REQUIRED', 'evidence');
  const allowed = new Set([
    'source_type', 'source_id', 'observed_at', ...extraFields,
  ]);
  strictShape(
    normalized,
    allowed,
    ['source_type', 'source_id', 'observed_at'],
    'evidence',
  );
  return {
    ...normalized,
    source_type: required(
      normalized.source_type,
      'EVIDENCE_SOURCE_INVALID',
      'evidence.source_type',
      3,
      60,
    ),
    source_id: required(
      normalized.source_id,
      'EVIDENCE_SOURCE_INVALID',
      'evidence.source_id',
      3,
      240,
    ),
    observed_at: timestamp(
      normalized.observed_at,
      'EVIDENCE_TIME_INVALID',
      'evidence.observed_at',
    ),
  };
}

function evidenceManifest(
  value,
  tenantId,
  reportType,
  sourceEvidenceId,
  sourceRunId,
) {
  const normalized = evidence(value, ['sources']);
  if (normalized.source_type !== 'engineering_evidence_manifest'
      || !Array.isArray(normalized.sources)
      || normalized.sources.length < 1
      || normalized.sources.length > 50) {
    throw new ProductEngineeringHeadError(
      'EVIDENCE_MANIFEST_INVALID',
      'reports require a bounded engineering evidence manifest',
    );
  }
  const identities = new Set();
  const sourceIds = new Set();
  const sourceTypes = new Set();
  const sources = normalized.sources.map((source) => {
    object(source, 'EVIDENCE_MANIFEST_INVALID', 'evidence source');
    strictShape(
      source,
      new Set([
        'source_type', 'source_id', 'source_tenant_id', 'digest', 'observed_at',
      ]),
      ['source_type', 'source_id', 'source_tenant_id', 'digest', 'observed_at'],
      'evidence.sources[]',
    );
    const sourceType = required(
      source.source_type,
      'EVIDENCE_MANIFEST_INVALID',
      'source_type',
      3,
      60,
    );
    const sourceId = required(
      source.source_id,
      'EVIDENCE_MANIFEST_INVALID',
      'source_id',
      3,
      240,
    );
    const sourceTenantId = uuid(
      source.source_tenant_id,
      'EVIDENCE_TENANT_INVALID',
      'source_tenant_id',
    );
    const digest = required(
      source.digest,
      'EVIDENCE_DIGEST_INVALID',
      'digest',
      64,
      64,
    ).toLowerCase();
    if (!EVIDENCE_SOURCE_TYPES.has(sourceType) || !DIGEST.test(digest)
        || sourceTenantId !== tenantId) {
      throw new ProductEngineeringHeadError(
        'EVIDENCE_MANIFEST_INVALID',
        'evidence source type, digest, or tenant is invalid',
      );
    }
    const identity = `${sourceType}:${sourceId}`;
    if (identities.has(identity)) {
      throw new ProductEngineeringHeadError(
        'EVIDENCE_MANIFEST_INVALID',
        'evidence source identities must be unique',
      );
    }
    identities.add(identity);
    sourceIds.add(sourceId);
    sourceTypes.add(sourceType);
    return {
      ...source,
      source_type: sourceType,
      source_id: sourceId,
      source_tenant_id: sourceTenantId,
      digest,
      observed_at: timestamp(
        source.observed_at,
        'EVIDENCE_TIME_INVALID',
        'source.observed_at',
      ),
    };
  });
  if (!sourceIds.has(sourceEvidenceId)
      || (sourceRunId && !sourceIds.has(sourceRunId))
      || REQUIRED_SOURCES[reportType].some(type => !sourceTypes.has(type))) {
    throw new ProductEngineeringHeadError(
      'AUTHORITATIVE_EVIDENCE_REQUIRED',
      `${reportType} is missing authoritative evidence`,
    );
  }
  return { ...normalized, sources };
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
    throw new ProductEngineeringHeadError(
      'ACTOR_AUTHORITY_INVALID',
      'actor type or authority is unsupported',
    );
  }
  let id = null;
  if (type === 'human') {
    id = uuid(input.actorId, 'ACTOR_ID_INVALID', 'actorId');
    if (!['operator', 'owner'].includes(authorityTier)) {
      throw new ProductEngineeringHeadError(
        'HUMAN_AUTHORITY_INVALID',
        'human authority must be operator or owner',
      );
    }
  } else if (type === 'agent') {
    id = required(input.actorId, 'ACTOR_ID_INVALID', 'actorId', 3, 160);
    if (authorityTier !== 'department_head') {
      throw new ProductEngineeringHeadError(
        'AGENT_AUTHORITY_INVALID',
        'the registered Head requires department_head authority',
      );
    }
  } else if (type === 'service') {
    id = required(input.actorId, 'ACTOR_ID_INVALID', 'actorId', 2, 160);
    if (authorityTier !== 'system') {
      throw new ProductEngineeringHeadError(
        'SERVICE_AUTHORITY_INVALID',
        'services require system authority',
      );
    }
  } else if (
    (input.actorId !== null && input.actorId !== undefined && input.actorId !== '')
    || authorityTier !== 'system'
  ) {
    throw new ProductEngineeringHeadError(
      'SYSTEM_ACTOR_INVALID',
      'system actors cannot claim an id or elevated authority',
    );
  }
  return { actorType: type, actorId: id, authorityTier };
}

function base(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ProductEngineeringHeadError('COMMAND_REQUIRED', 'command is required');
  }
  contained(input);
  const revision = Number(input.expectedControlRevision);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new ProductEngineeringHeadError(
      'CONTROL_REVISION_INVALID',
      'expectedControlRevision must be a non-negative safe integer',
    );
  }
  if (input.featureGateEnabled !== true) {
    throw new ProductEngineeringHeadError(
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
    throw new ProductEngineeringHeadError(
      'REQUEST_FINGERPRINT_INVALID',
      'requestFingerprint must be a SHA-256 digest',
    );
  }
  const tenantId = uuid(input.tenantId, 'TENANT_ID_INVALID', 'tenantId');
  const productTenantId = uuid(
      input.productTenantId,
      'PRODUCT_TENANT_ID_INVALID',
      'productTenantId',
    );
  if (productTenantId !== tenantId) {
    throw new ProductEngineeringHeadError(
      'CROSS_TENANT_COMMAND_FORBIDDEN',
      'product engineering commands cannot cross tenant boundaries',
    );
  }
  return {
    tenantId,
    productTenantId,
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
    throw new ProductEngineeringHeadError(
      'KPI_RESULTS_REQUIRED',
      'kpiResults must contain at least one KPI',
    );
  }
  const keys = new Set();
  for (const result of kpis) {
    object(result, 'KPI_RESULT_INVALID', 'KPI result');
    strictShape(
      result,
      new Set([
        'kpi_key', 'measured_value', 'verification_state', 'evidence_ref',
      ]),
      ['kpi_key', 'verification_state'],
      'kpi_results[]',
    );
    const key = required(result.kpi_key, 'KPI_KEY_INVALID', 'kpi_key', 3, 80);
    if (!CODE.test(key) || keys.has(key)) {
      throw new ProductEngineeringHeadError(
        'KPI_KEY_INVALID',
        'KPI keys must be unique machine codes',
      );
    }
    keys.add(key);
    if (!['verified', 'unverified', 'unknown'].includes(result.verification_state)) {
      throw new ProductEngineeringHeadError(
        'KPI_VERIFICATION_INVALID',
        'KPI verification state is invalid',
      );
    }
    if (requireVerified && (
      result.verification_state !== 'verified'
      || typeof result.evidence_ref !== 'string'
      || result.evidence_ref.trim().length < 3
    )) {
      throw new ProductEngineeringHeadError(
        'FALSE_OUTCOME_FORBIDDEN',
        'verified product outcomes require evidence for every KPI',
      );
    }
  }
  for (const requiredKey of REQUIRED_KPIS[reportType]) {
    if (!keys.has(requiredKey)) {
      throw new ProductEngineeringHeadError(
        'KPI_CONTRACT_INCOMPLETE',
        `${reportType} reports require ${requiredKey}`,
      );
    }
  }
  return kpis;
}

function reportBody(value) {
  const normalized = object(value, 'REPORT_BODY_INVALID', 'reportBody');
  strictShape(
    normalized,
    new Set(['summary', 'findings', 'exceptions', 'recommendations']),
    ['summary'],
    'report_body',
  );
  required(normalized.summary, 'REPORT_BODY_INVALID', 'reportBody.summary', 3, 2000);
  for (const key of ['findings', 'exceptions', 'recommendations']) {
    if (!Object.hasOwn(normalized, key)) continue;
    if (!Array.isArray(normalized[key]) || normalized[key].length > 50) {
      throw new ProductEngineeringHeadError(
        'REPORT_BODY_INVALID',
        `reportBody.${key} must be a bounded string array`,
      );
    }
    normalized[key].forEach((item) => {
      required(item, 'REPORT_BODY_INVALID', `reportBody.${key}[]`, 1, 1000);
    });
  }
  return normalized;
}

function planProductEngineeringOutcomeReceipt(input = {}) {
  const common = base(input);
  const verifiedByUserId = uuid(
    input.verifiedByUserId,
    'VERIFIER_ID_INVALID',
    'verifiedByUserId',
  );
  if (input.actorType !== 'human'
      || input.authorityTier !== 'owner'
      || input.actorId !== verifiedByUserId) {
    throw new ProductEngineeringHeadError(
      'INDEPENDENT_OWNER_VERIFIER_REQUIRED',
      'a same-tenant owner must verify the canonical product outcome receipt',
    );
  }
  const receiptId = uuid(input.receiptId, 'RECEIPT_ID_INVALID', 'receiptId');
  const outcomeState = required(
    input.outcomeState,
    'OUTCOME_STATE_INVALID',
    'outcomeState',
    8,
    12,
  ).toLowerCase();
  const measurementDigest = required(
    input.measurementDigest,
    'MEASUREMENT_DIGEST_INVALID',
    'measurementDigest',
    64,
    64,
  ).toLowerCase();
  if (!['achieved', 'not_achieved'].includes(outcomeState)
      || !DIGEST.test(measurementDigest)) {
    throw new ProductEngineeringHeadError(
      'OUTCOME_RECEIPT_INVALID',
      'outcome receipt state or measurement digest is invalid',
    );
  }
  const observedAt = timestamp(
    input.observedAt,
    'OUTCOME_RECEIPT_TIME_INVALID',
    'observedAt',
  );
  const ev = evidence(input.evidence, ['measurement_digest']);
  if (ev.source_type !== 'owner_verified_product_outcome'
      || ev.source_id !== receiptId
      || ev.measurement_digest !== measurementDigest
      || ev.observed_at !== observedAt) {
    throw new ProductEngineeringHeadError(
      'OUTCOME_RECEIPT_INVALID',
      'receipt evidence must exactly identify the measured owner verification',
    );
  }
  const planned = {
    ...common,
    receiptId,
    outcomeState,
    measurementDigest,
    observedAt,
    evidence: ev,
    verifiedByUserId,
    ...actor(input),
  };
  return Object.freeze({
    kind: 'productEngineering_outcome_receipt',
    ...planned,
    evidenceDigest: sha256(stableJson(ev)),
    semanticFingerprint: sha256(stableJson(planned)),
    operationalActionPermitted: false,
  });
}

function planProductEngineeringHeadReport(input = {}) {
  const common = base(input);
  const reportType = required(
    input.reportType,
    'REPORT_TYPE_INVALID',
    'reportType',
    7,
    24,
  ).toLowerCase();
  const productScope = required(
    input.productScope,
    'PRODUCT_SCOPE_INVALID',
    'productScope',
    3,
    12,
  ).toLowerCase();
  const executionState = required(
    input.executionHealthState,
    'EXECUTION_STATE_INVALID',
    'executionHealthState',
    6,
    8,
  ).toLowerCase();
  const outcomeState = required(
    input.productOutcomeState,
    'OUTCOME_STATE_INVALID',
    'productOutcomeState',
    7,
    12,
  ).toLowerCase();
  if (!REPORT_TYPES.has(reportType)
      || !PRODUCT_SCOPES.has(productScope)
      || !EXECUTION_STATES.has(executionState)
      || !PRODUCT_OUTCOMES.has(outcomeState)) {
    throw new ProductEngineeringHeadError(
      'REPORT_CONTRACT_INVALID',
      'report type or state is unsupported',
    );
  }
  const outcomeVerified = input.outcomeVerified === true;
  const isProvenOutcome = ['achieved', 'not_achieved'].includes(outcomeState);
  if (outcomeVerified !== isProvenOutcome
      || (isProvenOutcome && reportType !== 'product_outcome')) {
    throw new ProductEngineeringHeadError(
      'OUTCOME_VERIFICATION_INVALID',
      'only product_outcome reports may verify achieved/not_achieved outcomes',
    );
  }
  const sourceEvidenceId = uuid(
    input.sourceEvidenceId,
    'SOURCE_EVIDENCE_ID_INVALID',
    'sourceEvidenceId',
  );
  const sourceRunId = uuid(
    input.sourceRunId,
    'SOURCE_RUN_ID_INVALID',
    'sourceRunId',
    true,
  );
  const ev = evidenceManifest(
    input.evidence,
    common.tenantId,
    reportType,
    sourceEvidenceId,
    sourceRunId,
  );
  const kpis = validatedKpis(
    input.kpiResults,
    reportType,
    isProvenOutcome,
  );
  if (isProvenOutcome && (
    sourceEvidenceId === null
    || kpis.some(result => result.evidence_ref
      !== `product_outcome_receipt:${sourceEvidenceId}`)
  )) {
    throw new ProductEngineeringHeadError(
      'CANONICAL_OUTCOME_RECEIPT_REQUIRED',
      'verified KPI evidence must bind to the canonical outcome receipt',
    );
  }
  const planned = {
    ...common,
    reportId: uuid(input.reportId, 'REPORT_ID_INVALID', 'reportId'),
    sourceEvidenceId,
    sourceRunId,
    reportType,
    productScope,
    periodStart: timestamp(input.periodStart, 'PERIOD_INVALID', 'periodStart'),
    periodEnd: timestamp(input.periodEnd, 'PERIOD_INVALID', 'periodEnd'),
    executionHealthState: executionState,
    productOutcomeState: outcomeState,
    outcomeVerified,
    kpiResults: kpis,
    reportBody: reportBody(input.reportBody),
    evidence: ev,
    ...actor(input),
  };
  if (Date.parse(planned.periodEnd) <= Date.parse(planned.periodStart)) {
    throw new ProductEngineeringHeadError(
      'PERIOD_INVALID',
      'periodEnd must follow periodStart',
    );
  }
  const semantics = { ...planned };
  return Object.freeze({
    kind: 'productEngineering_head_report',
    ...planned,
    evidenceDigest: sha256(stableJson(ev)),
    semanticFingerprint: sha256(stableJson(semantics)),
    operationalActionPermitted: false,
  });
}

function planProductEngineeringHeadCaseCommand(input = {}) {
  const common = base(input);
  const action = required(input.action, 'ACTION_INVALID', 'action', 3, 40)
    .toLowerCase();
  if (!ACTIONS.has(action)) {
    throw new ProductEngineeringHeadError('ACTION_INVALID', 'action is unsupported');
  }
  const expectedRevision = Number(input.expectedRevision);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new ProductEngineeringHeadError(
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
    productOutcomeState: input.productOutcomeState === null
      || input.productOutcomeState === undefined
      ? null
      : required(
        input.productOutcomeState,
        'OUTCOME_STATE_INVALID',
        'productOutcomeState',
        8,
        12,
      ).toLowerCase(),
    productOutcomeReceiptId: uuid(
      input.productOutcomeReceiptId,
      'OUTCOME_RECEIPT_ID_INVALID',
      'productOutcomeReceiptId',
      true,
    ),
    decision: input.decision === null || input.decision === undefined
      ? null
      : required(input.decision, 'DECISION_INVALID', 'decision', 8, 8)
        .toLowerCase(),
    evidence: evidence(input.evidence),
    ...actor(input),
  };
  const evidenceSources = {
    create_goal: ['supervised_goal_contract'],
    complete_goal: ['product_outcome_receipt'],
    create_work: ['supervised_work_contract'],
    accept_work: ['assignment_acceptance'],
    escalate_work: ['sla_breach', 'operator_escalation'],
    complete_work: ['engineering_completion_receipt'],
    record_product_outcome: ['product_outcome_receipt'],
    recommend_decision: ['engineering_recommendation'],
    decide_recommendation: ['human_decision_record'],
    raise_exception: ['engineering_exception'],
    resolve_exception: ['exception_resolution_receipt'],
  };
  if (!evidenceSources[action].includes(normalized.evidence.source_type)) {
    throw new ProductEngineeringHeadError(
      'EVENT_EVIDENCE_INVALID',
      `${action} requires its documented event evidence source`,
    );
  }

  if (['create_goal', 'create_work', 'recommend_decision', 'raise_exception']
    .includes(action)) {
    if (expectedRevision !== 0 || !normalized.ownerId || !normalized.slaDueAt
        || !normalized.title
        || !normalized.contract
        || typeof normalized.contract !== 'object'
        || Array.isArray(normalized.contract)
        || Object.keys(normalized.contract).length === 0) {
      throw new ProductEngineeringHeadError(
        'CASE_CREATION_INVALID',
        'creation requires revision zero, owner, SLA, title, and contract',
      );
    }
    const contractShapes = {
      create_goal: {
        required: ['objective', 'success_criteria'],
        allowed: ['objective', 'success_criteria', 'constraints'],
      },
      create_work: {
        required: ['objective', 'acceptance_criteria'],
        allowed: ['objective', 'acceptance_criteria', 'constraints'],
      },
      recommend_decision: {
        required: ['decision_required'],
        allowed: ['decision_required', 'options', 'constraints'],
      },
      raise_exception: {
        required: ['exception', 'resolution_criteria'],
        allowed: ['exception', 'resolution_criteria', 'constraints'],
      },
    };
    const shape = contractShapes[action];
    strictShape(
      normalized.contract,
      new Set(shape.allowed),
      shape.required,
      'contract',
    );
    for (const [key, value] of Object.entries(normalized.contract)) {
      if (Array.isArray(value)) {
        if (value.length < 1 || value.length > 50) {
          throw new ProductEngineeringHeadError(
            'CASE_CONTRACT_INVALID',
            `contract.${key} must be a bounded string array`,
          );
        }
        value.forEach(item => required(
          item, 'CASE_CONTRACT_INVALID', `contract.${key}[]`, 1, 500,
        ));
      } else {
        required(value, 'CASE_CONTRACT_INVALID', `contract.${key}`, 1, 1000);
      }
    }
    if (action === 'create_work' && !normalized.assigneeId) {
      throw new ProductEngineeringHeadError(
        'ASSIGNEE_REQUIRED',
        'work creation requires an assignee',
      );
    }
    if (normalized.actorType === 'human'
        && normalized.authorityTier !== 'owner') {
      throw new ProductEngineeringHeadError(
        'ACTION_AUTHORITY_DENIED',
        'human case creation requires owner authority',
      );
    }
  }
  if (action === 'escalate_work'
      && (!normalized.escalationCode || !CODE.test(normalized.escalationCode))) {
    throw new ProductEngineeringHeadError(
      'ESCALATION_CODE_REQUIRED',
      'escalation requires a stable machine code',
    );
  }
  if (['complete_goal', 'record_product_outcome'].includes(action)) {
    if (!normalized.sourceReportId
        || !normalized.productOutcomeReceiptId
        || !['achieved', 'not_achieved'].includes(normalized.productOutcomeState)
        || normalized.evidence.source_type !== 'product_outcome_receipt'
        || normalized.evidence.source_id !== normalized.productOutcomeReceiptId) {
      throw new ProductEngineeringHeadError(
        'PRODUCT_OUTCOME_EVIDENCE_REQUIRED',
        'product outcomes require a verified outcome report and receipt',
      );
    }
    if (normalized.actorType === 'human'
        && normalized.authorityTier !== 'owner') {
      throw new ProductEngineeringHeadError(
        'ACTION_AUTHORITY_DENIED',
        'human product outcome recording requires owner authority',
      );
    }
  } else if (normalized.productOutcomeState !== null
      || normalized.productOutcomeReceiptId !== null) {
    throw new ProductEngineeringHeadError(
      'PRODUCT_OUTCOME_FORBIDDEN',
      'engineering completion cannot carry a product outcome',
    );
  }
  if (action === 'accept_work' && (
    normalized.actorType !== 'human'
    || normalized.evidence.source_type !== 'assignment_acceptance'
  )) {
    throw new ProductEngineeringHeadError(
      'WORK_ACCEPTANCE_INVALID',
      'assignment acceptance requires human receipt evidence',
    );
  }
  if (action === 'complete_work' && (
    normalized.actorType !== 'human'
    || normalized.evidence.source_type !== 'engineering_completion_receipt'
  )) {
    throw new ProductEngineeringHeadError(
      'WORK_COMPLETION_INVALID',
      'engineering completion requires a human completion receipt',
    );
  }
  if (action === 'decide_recommendation') {
    if (!['approved', 'rejected'].includes(normalized.decision)
        || normalized.actorType !== 'human'
        || normalized.authorityTier !== 'owner'
        || normalized.evidence.source_type !== 'human_decision_record') {
      throw new ProductEngineeringHeadError(
        'HUMAN_DECISION_REQUIRED',
        'only an owner-authorized human can decide a recommendation',
      );
    }
  } else if (normalized.decision !== null) {
    throw new ProductEngineeringHeadError(
      'DECISION_FORBIDDEN',
      'this action cannot carry a decision',
    );
  }
  const semantics = { ...normalized };
  const resultingProductOutcomeState = action === 'complete_work'
    ? 'unproven'
    : action === 'record_product_outcome'
      ? normalized.productOutcomeState
      : null;
  return Object.freeze({
    kind: 'productEngineering_head_case_command',
    ...normalized,
    resultingProductOutcomeState,
    evidenceDigest: sha256(stableJson(normalized.evidence)),
    semanticFingerprint: sha256(stableJson(semantics)),
    operationalActionPermitted: false,
  });
}

module.exports = {
  ProductEngineeringHeadError,
  planProductEngineeringOutcomeReceipt,
  planProductEngineeringHeadReport,
  planProductEngineeringHeadCaseCommand,
  stableJson,
};
