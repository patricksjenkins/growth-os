'use strict';

const crypto = require('node:crypto');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA_RE = /^[a-f0-9]{64}$/;
const FORBIDDEN_NORMALIZED = new Set([
  'publish', 'publication', 'contentpublication', 'send', 'dispatch',
  'providerdispatch', 'customercontact', 'customeremail', 'customerphone',
  'email', 'sms', 'mms', 'voice',
  'paidadvertising', 'adspend', 'spend', 'charge', 'refund', 'transfer',
  'pricing', 'legalpolicy', 'productionwrite', 'providertoken', 'causalclaim',
  'attributionmodel', 'qualitystate', 'deliverystate', 'businesseffectstate',
  'authorization', 'apikey', 'accesstoken', 'refreshtoken', 'password',
  'secret', 'credential', 'cookie', 'setcookie', 'privatekey', 'clientsecret',
]);
const EVIDENCE_KEYS = new Set([
  'source_type', 'source_id', 'observed_at', 'evidence_digest',
]);
const OPAQUE_METADATA_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,159}$/;
const COMMANDS = new Set([
  'accept_report', 'create_case', 'accept_work', 'escalate_work',
  'complete_work', 'record_outcome', 'complete_goal',
  'decide_decision', 'resolve_exception',
]);

class MarketingBrandPlanningError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MarketingBrandPlanningError';
    this.code = code;
  }
}

function text(value, code, label, min = 1, max = 240) {
  if (typeof value !== 'string') {
    throw new MarketingBrandPlanningError(code, `${label} must be a string`);
  }
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) {
    throw new MarketingBrandPlanningError(code, `${label} length is invalid`);
  }
  return normalized;
}

function optionalText(value, code, label, min = 1, max = 240) {
  if (value === undefined || value === null || value === '') return null;
  return text(value, code, label, min, max);
}

function uuid(value, code, label) {
  const normalized = text(value, code, label, 36, 36).toLowerCase();
  if (!UUID_RE.test(normalized)) {
    throw new MarketingBrandPlanningError(code, `${label} must be a UUID`);
  }
  return normalized;
}

function optionalUuid(value, code, label) {
  if (value === undefined || value === null || value === '') return null;
  return uuid(value, code, label);
}

function timestamp(value, code, label) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = text(value, code, label, 20, 40);
  if (!Number.isFinite(Date.parse(normalized))) {
    throw new MarketingBrandPlanningError(code, `${label} is invalid`);
  }
  return new Date(normalized).toISOString();
}

function rejectForbidden(value, path = 'input') {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectForbidden(item, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (FORBIDDEN_NORMALIZED.has(normalizedKey)) {
      throw new MarketingBrandPlanningError(
        'PRODUCTION_ACTION_FORBIDDEN', `${path}.${key} is forbidden`,
      );
    }
    rejectForbidden(child, `${path}.${key}`);
  }
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stable(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function evidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MarketingBrandPlanningError(
      'EVIDENCE_REQUIRED', 'evidence must be an object',
    );
  }
  for (const key of Object.keys(value)) {
    if (!EVIDENCE_KEYS.has(key) || typeof value[key] !== 'string') {
      throw new MarketingBrandPlanningError(
        'EVIDENCE_SCHEMA_INVALID',
        `evidence.${key} is not in the minimized evidence schema`,
      );
    }
  }
  const observedAt = timestamp(
    value.observed_at, 'EVIDENCE_TIME_INVALID', 'evidence.observed_at',
  );
  if (!observedAt) {
    throw new MarketingBrandPlanningError(
      'EVIDENCE_TIME_INVALID', 'evidence.observed_at is required',
    );
  }
  const minimized = {
    source_type: text(
      value.source_type, 'EVIDENCE_SOURCE_INVALID', 'evidence.source_type', 3, 80,
    ),
    source_id: text(
      value.source_id, 'EVIDENCE_ID_INVALID', 'evidence.source_id', 3, 240,
    ),
    observed_at: observedAt,
  };
  if (!/^[a-z][a-z0-9_]{1,79}$/.test(minimized.source_type)
      || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{1,239}$/.test(minimized.source_id)) {
    throw new MarketingBrandPlanningError(
      'EVIDENCE_SCHEMA_INVALID', 'evidence identifiers are invalid',
    );
  }
  if (value.evidence_digest !== undefined) {
    minimized.evidence_digest = text(
      value.evidence_digest,
      'EVIDENCE_DIGEST_INVALID',
      'evidence.evidence_digest',
      64,
      64,
    );
    if (!SHA_RE.test(minimized.evidence_digest)) {
      throw new MarketingBrandPlanningError(
        'EVIDENCE_DIGEST_INVALID', 'evidence.evidence_digest is invalid',
      );
    }
  }
  return minimized;
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function nonnegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function structuredReport(value) {
  const sections = {
    content_quality: 'accepted',
    delivery_receipts: 'delivered',
    audience: 'observed',
    replies: 'observed',
    conversions: 'observed',
    brand_compliance_exceptions: 'open',
    cohort: 'size',
  };
  if (!exactKeys(value, Object.keys(sections))) {
    throw new MarketingBrandPlanningError(
      'REPORT_METADATA_INVALID',
      'structuredReport must contain only the documented report sections',
    );
  }
  const minimized = {};
  for (const [section, metric] of Object.entries(sections)) {
    if (!exactKeys(value[section], [metric])
        || !nonnegativeSafeInteger(value[section][metric])) {
      throw new MarketingBrandPlanningError(
        'REPORT_METADATA_INVALID',
        `structuredReport.${section} must contain only non-negative ${metric}`,
      );
    }
    minimized[section] = { [metric]: value[section][metric] };
  }
  return minimized;
}

function caseContract(caseType, value) {
  if (caseType === 'goal'
      && exactKeys(value, ['measure'])
      && OPAQUE_METADATA_VALUE.test(value.measure ?? '')) {
    return { measure: value.measure };
  }
  if (caseType === 'work'
      && exactKeys(value, ['acceptance'])
      && Array.isArray(value.acceptance)
      && value.acceptance.length >= 1
      && value.acceptance.length <= 20
      && value.acceptance.every((item) => (
        typeof item === 'string' && OPAQUE_METADATA_VALUE.test(item)
      ))) {
    return { acceptance: [...value.acceptance] };
  }
  if (caseType === 'decision'
      && exactKeys(value, ['decision_scope'])
      && OPAQUE_METADATA_VALUE.test(value.decision_scope ?? '')) {
    return { decision_scope: value.decision_scope };
  }
  if (caseType === 'exception'
      && exactKeys(value, ['resolution'])
      && OPAQUE_METADATA_VALUE.test(value.resolution ?? '')) {
    return { resolution: value.resolution };
  }
  throw new MarketingBrandPlanningError(
    'CASE_METADATA_INVALID',
    'contract does not match the documented case-type schema',
  );
}

function uniqueUuids(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new MarketingBrandPlanningError(
      'SOURCE_IDS_INVALID', `${label} must be an array`,
    );
  }
  const ids = value.map((item) => uuid(item, 'SOURCE_ID_INVALID', label));
  if (new Set(ids).size !== ids.length) {
    throw new MarketingBrandPlanningError(
      'DUPLICATE_SOURCE_IDS', `${label} must be distinct`,
    );
  }
  return ids;
}

function nonnegativeInteger(value, code, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new MarketingBrandPlanningError(code, `${label} must be non-negative`);
  }
  return value;
}

function reportPayload(input) {
  const contentVersionIds = uniqueUuids(
    input.contentVersionIds, 'contentVersionIds',
  );
  const qualityEvaluationIds = uniqueUuids(
    input.qualityEvaluationIds, 'qualityEvaluationIds',
  );
  const deliveryReceiptIds = uniqueUuids(
    input.deliveryReceiptIds, 'deliveryReceiptIds',
  );
  const audience = nonnegativeInteger(
    input.audienceObservedCount, 'AUDIENCE_INVALID', 'audienceObservedCount',
  );
  const replies = nonnegativeInteger(
    input.replyObservedCount, 'REPLIES_INVALID', 'replyObservedCount',
  );
  const conversions = nonnegativeInteger(
    input.conversionObservedCount,
    'CONVERSIONS_INVALID',
    'conversionObservedCount',
  );
  const cohort = nonnegativeInteger(
    input.cohortSize, 'COHORT_INVALID', 'cohortSize',
  );
  const metricsDigest = optionalText(
    input.metricsEvidenceDigest,
    'METRICS_DIGEST_INVALID',
    'metricsEvidenceDigest',
    64,
    64,
  );
  const minimizedReport = structuredReport(input.structuredReport);
  if (contentVersionIds.length === 0
      || !/^\d{4}-(0[1-9]|1[0-2])-01$/.test(input.reportingPeriodStart ?? '')
      || !['succeeded', 'failed', 'unknown'].includes(input.executionHealth)
      || !['completed', 'partial', 'unverified'].includes(
        input.contentCompletionState,
      )
      || !['verified', 'exception', 'unverified'].includes(
        input.brandComplianceState,
      )
      || !SHA_RE.test(input.brandComplianceEvidenceDigest ?? '')
      || replies > audience
      || conversions > audience
      || (metricsDigest === null
        && (audience !== 0 || replies !== 0 || conversions !== 0 || cohort !== 0))
      || (metricsDigest !== null && (!SHA_RE.test(metricsDigest)
        || cohort === 0 || audience > cohort))) {
    throw new MarketingBrandPlanningError(
      'REPORT_CONTRACT_INVALID', 'report evidence contract is incomplete',
    );
  }
  return {
    report_id: uuid(input.reportId, 'REPORT_ID_INVALID', 'reportId'),
    reporting_period_start: input.reportingPeriodStart,
    content_version_ids: contentVersionIds,
    quality_evaluation_ids: qualityEvaluationIds,
    delivery_receipt_ids: deliveryReceiptIds,
    execution_health: input.executionHealth,
    content_completion_state: input.contentCompletionState,
    brand_compliance_state: input.brandComplianceState,
    brand_compliance_evidence_digest: input.brandComplianceEvidenceDigest,
    audience_observed_count: audience,
    reply_observed_count: replies,
    conversion_observed_count: conversions,
    cohort_size: cohort,
    ...(metricsDigest ? { metrics_evidence_digest: metricsDigest } : {}),
    structured_report: minimizedReport,
  };
}

function casePayload(input, command) {
  const payload = {
    case_id: uuid(input.caseId, 'CASE_ID_INVALID', 'caseId'),
  };
  if (input.assigneeId !== undefined && input.assigneeId !== null
      && input.assigneeId !== '') {
    throw new MarketingBrandPlanningError(
      'ASSIGNEE_ID_FORBIDDEN',
      'Marketing Head work is explicitly assigned to the registered Head actor',
    );
  }
  if (command === 'create_case') {
    payload.report_id = uuid(input.reportId, 'REPORT_ID_INVALID', 'reportId');
    payload.case_type = text(
      input.caseType, 'CASE_TYPE_INVALID', 'caseType', 4, 9,
    ).toLowerCase();
    payload.title = text(input.title, 'TITLE_INVALID', 'title', 3, 240);
    payload.owner_id = uuid(input.ownerId, 'OWNER_ID_INVALID', 'ownerId');
    payload.sla_due_at = timestamp(input.slaDueAt, 'SLA_INVALID', 'slaDueAt');
    payload.contract = caseContract(payload.case_type, input.contract);
  } else if (command === 'escalate_work') {
    payload.escalation_code = text(
      input.escalationCode, 'ESCALATION_INVALID', 'escalationCode', 3, 80,
    );
  } else if ([
    'record_outcome', 'complete_goal', 'resolve_exception',
  ].includes(command)) {
    payload.outcome_state = text(
      input.outcomeState, 'OUTCOME_INVALID', 'outcomeState', 14, 21,
    );
  } else if (command === 'decide_decision') {
    payload.decision_result = text(
      input.decisionResult,
      'DECISION_RESULT_INVALID',
      'decisionResult',
      8,
      8,
    ).toLowerCase();
  }
  return payload;
}

function planMarketingBrandHeadCommand(input = {}) {
  rejectForbidden(input);
  const command = text(
    input.command, 'COMMAND_INVALID', 'command', 10, 30,
  ).toLowerCase();
  if (!COMMANDS.has(command)) {
    throw new MarketingBrandPlanningError('COMMAND_INVALID', 'unsupported command');
  }
  if (!Number.isSafeInteger(input.expectedRevision)
      || input.expectedRevision < 0) {
    throw new MarketingBrandPlanningError(
      'REVISION_INVALID', 'expectedRevision must be non-negative',
    );
  }
  const payload = command === 'accept_report'
    ? reportPayload(input)
    : casePayload(input, command);
  const args = {
    p_tenant_id: uuid(input.tenantId, 'TENANT_ID_INVALID', 'tenantId'),
    p_command: command,
    p_payload: payload,
    p_expected_revision: input.expectedRevision,
    p_idempotency_key: text(
      input.idempotencyKey, 'IDEMPOTENCY_INVALID', 'idempotencyKey', 8, 200,
    ),
    p_request_fingerprint: null,
    p_actor_id: text(input.actorId, 'ACTOR_ID_INVALID', 'actorId', 3, 160),
    p_authority_tier: 'department_head',
    p_evidence: evidence(input.evidence),
    p_feature_gate_enabled: input.featureGateEnabled === true,
  };
  args.p_request_fingerprint = hash(stable(args));
  return {
    rpc: 'marketing_brand_head_command_rpc',
    args,
    safety: {
      executionMode: 'supervised_read_only',
      publicationAllowed: false,
      providerDispatchAllowed: false,
      customerContactAllowed: false,
      paidAdvertisingAllowed: false,
      spendAllowed: false,
      productionWriteAllowed: false,
      performsIo: false,
    },
  };
}

function verifyPlanFingerprint(plan) {
  if (!plan || !plan.args) return false;
  const args = { ...plan.args, p_request_fingerprint: null };
  return hash(stable(args)) === plan.args.p_request_fingerprint;
}

module.exports = {
  MarketingBrandPlanningError,
  planMarketingBrandHeadCommand,
  verifyPlanFingerprint,
};
