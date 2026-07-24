'use strict';

const crypto = require('node:crypto');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA_RE = /^[a-f0-9]{64}$/;
const DEPARTMENTS = new Set([
  'reliability_security_agent_ops',
  'revenue_sales',
  'onboarding_implementation',
  'client_success_support',
  'finance_data_governance',
  'marketing_brand',
  'product_engineering',
]);
const RECORD_TYPES = new Set([
  'company_goal',
  'dependency',
  'capacity_conflict',
  'decision_required',
  'exception',
  'follow_through',
]);
const FORBIDDEN_KEYS = new Set([
  'send', 'dispatch', 'publish', 'charge', 'refund', 'transfer',
  'productionWrite', 'providerPayload', 'providerToken',
  'customerEmail', 'customerPhone', 'executeAction', 'writeAuthority',
]);

class ChiefOfStaffPlanningError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ChiefOfStaffPlanningError';
    this.code = code;
  }
}

function string(value, code, label, min = 1, max = 240) {
  if (typeof value !== 'string') {
    throw new ChiefOfStaffPlanningError(code, `${label} must be a string`);
  }
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) {
    throw new ChiefOfStaffPlanningError(code, `${label} length is invalid`);
  }
  return normalized;
}

function optionalString(value, code, label, min = 1, max = 240) {
  if (value === null || value === undefined || value === '') return null;
  return string(value, code, label, min, max);
}

function uuid(value, code, label) {
  const normalized = string(value, code, label, 36, 36).toLowerCase();
  if (!UUID_RE.test(normalized)) {
    throw new ChiefOfStaffPlanningError(code, `${label} must be a UUID`);
  }
  return normalized;
}

function optionalUuid(value, code, label) {
  if (value === null || value === undefined || value === '') return null;
  return uuid(value, code, label);
}

function revision(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ChiefOfStaffPlanningError(
      'REVISION_INVALID',
      'expectedRevision must be a non-negative safe integer',
    );
  }
  return value;
}

function date(value, code, label) {
  const normalized = string(value, code, label, 10, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)
      || Number.isNaN(Date.parse(`${normalized}T00:00:00Z`))) {
    throw new ChiefOfStaffPlanningError(code, `${label} must be an ISO date`);
  }
  return normalized;
}

function timestamp(value, code, label) {
  const normalized = string(value, code, label, 20, 40);
  if (!Number.isFinite(Date.parse(normalized))) {
    throw new ChiefOfStaffPlanningError(code, `${label} must be an ISO timestamp`);
  }
  return new Date(normalized).toISOString();
}

function optionalTimestamp(value, code, label) {
  if (value === null || value === undefined || value === '') return null;
  return timestamp(value, code, label);
}

function rejectForbidden(value, path = 'input') {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectForbidden(item, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new ChiefOfStaffPlanningError(
        'PRODUCTION_BOUND_INPUT_FORBIDDEN',
        `${path}.${key} is forbidden in supervised mode`,
      );
    }
    rejectForbidden(child, `${path}.${key}`);
  }
}

function evidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ChiefOfStaffPlanningError(
      'EVIDENCE_REQUIRED',
      'evidence must be an object',
    );
  }
  return {
    ...value,
    source_type: string(
      value.source_type, 'EVIDENCE_SOURCE_INVALID', 'evidence.source_type', 3, 80,
    ),
    source_id: string(
      value.source_id, 'EVIDENCE_ID_INVALID', 'evidence.source_id', 3, 240,
    ),
    observed_at: timestamp(
      value.observed_at, 'EVIDENCE_TIME_INVALID', 'evidence.observed_at',
    ),
  };
}

function actor(input) {
  const actorType = string(
    input.actorType, 'ACTOR_TYPE_INVALID', 'actorType', 5, 7,
  ).toLowerCase();
  const authorityTier = string(
    input.authorityTier, 'AUTHORITY_INVALID', 'authorityTier', 5, 20,
  ).toLowerCase();
  if (!['human', 'agent', 'service'].includes(actorType)
      || !['department_head', 'chief_of_staff', 'owner'].includes(
        authorityTier,
      )) {
    throw new ChiefOfStaffPlanningError(
      'ACTOR_AUTHORITY_INVALID',
      'actor authority is unsupported',
    );
  }
  const actorId = actorType === 'human'
    ? uuid(input.actorId, 'ACTOR_ID_INVALID', 'actorId')
    : string(input.actorId, 'ACTOR_ID_INVALID', 'actorId', 2, 160);
  if (actorType !== 'human' && authorityTier === 'owner') {
    throw new ChiefOfStaffPlanningError(
      'NON_HUMAN_OWNER_FORBIDDEN',
      'only a human can claim owner authority',
    );
  }
  return { actorType, actorId, authorityTier };
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

function fingerprint(args) {
  return hash(stable(args));
}

function common(input) {
  rejectForbidden(input);
  const normalizedEvidence = evidence(input.evidence);
  const normalizedActor = actor(input);
  return {
    tenantId: uuid(input.tenantId, 'TENANT_ID_INVALID', 'tenantId'),
    expectedRevision: revision(input.expectedRevision),
    idempotencyKey: string(
      input.idempotencyKey, 'IDEMPOTENCY_INVALID', 'idempotencyKey', 8, 200,
    ),
    evidence: normalizedEvidence,
    ...normalizedActor,
    featureGateEnabled: input.featureGateEnabled === true,
  };
}

function planDepartmentReportCommand(input = {}) {
  const base = common(input);
  const command = string(
    input.command, 'COMMAND_INVALID', 'command', 8, 30,
  ).toLowerCase();
  if (![
    'register_contract', 'accept_contract', 'submit_report', 'accept_report',
  ].includes(command)) {
    throw new ChiefOfStaffPlanningError('COMMAND_INVALID', 'unsupported command');
  }
  const department = string(
    input.department, 'DEPARTMENT_INVALID', 'department', 5, 50,
  ).toLowerCase();
  if (!DEPARTMENTS.has(department)) {
    throw new ChiefOfStaffPlanningError(
      'DEPARTMENT_INVALID',
      'department is unsupported',
    );
  }
  if (['accept_contract', 'accept_report'].includes(command)
      && (base.actorType !== 'human' || base.authorityTier !== 'owner')) {
    throw new ChiefOfStaffPlanningError(
      'OWNER_ACCEPTANCE_REQUIRED',
      'report acceptance requires a human owner',
    );
  }
  const args = {
    p_tenant_id: base.tenantId,
    p_command: command,
    p_department: department,
    p_contract_id: uuid(input.contractId, 'CONTRACT_ID_INVALID', 'contractId'),
    p_contract_version: input.contractVersion,
    p_schema_digest: string(
      input.schemaDigest, 'SCHEMA_DIGEST_INVALID', 'schemaDigest', 64, 64,
    ).toLowerCase(),
    p_report_id: optionalUuid(input.reportId, 'REPORT_ID_INVALID', 'reportId'),
    p_source_department_report_id: optionalUuid(
      input.sourceDepartmentReportId,
      'SOURCE_REPORT_ID_INVALID',
      'sourceDepartmentReportId',
    ),
    p_reporting_period_start: input.reportingPeriodStart
      ? date(input.reportingPeriodStart, 'PERIOD_INVALID', 'reportingPeriodStart')
      : null,
    p_reporting_period_end: input.reportingPeriodEnd
      ? date(input.reportingPeriodEnd, 'PERIOD_INVALID', 'reportingPeriodEnd')
      : null,
    p_report_digest: optionalString(
      input.reportDigest, 'REPORT_DIGEST_INVALID', 'reportDigest', 64, 64,
    ),
    p_outcome_health: optionalString(
      input.outcomeHealth, 'HEALTH_INVALID', 'outcomeHealth', 7, 9,
    ),
    p_structured_summary: input.structuredSummary ?? {},
    p_expected_revision: base.expectedRevision,
    p_idempotency_key: base.idempotencyKey,
    p_actor_type: base.actorType,
    p_actor_id: base.actorId,
    p_authority_tier: base.authorityTier,
    p_evidence: base.evidence,
    p_feature_gate_enabled: base.featureGateEnabled,
  };
  if (!Number.isSafeInteger(args.p_contract_version)
      || args.p_contract_version < 1
      || !SHA_RE.test(args.p_schema_digest)
      || (args.p_report_digest && !SHA_RE.test(args.p_report_digest))) {
    throw new ChiefOfStaffPlanningError(
      'REPORT_CONTRACT_INVALID',
      'report contract identity is invalid',
    );
  }
  args.p_request_fingerprint = fingerprint(args);
  return {
    rpc: 'cos_report_command_rpc',
    args,
    safety: {
      executionMode: 'shadow',
      readOnly: true,
      productionActionsAllowed: false,
      performsIo: false,
    },
  };
}

function planChiefOfStaffCommand(input = {}) {
  const base = common(input);
  const command = string(
    input.command, 'COMMAND_INVALID', 'command', 10, 30,
  ).toLowerCase();
  if (![
    'open_cycle', 'create_record', 'accept_follow_through',
    'escalate_follow_through', 'complete_follow_through', 'close_cycle',
  ].includes(command)) {
    throw new ChiefOfStaffPlanningError('COMMAND_INVALID', 'unsupported command');
  }
  const start = date(
    input.reportingPeriodStart, 'PERIOD_INVALID', 'reportingPeriodStart',
  );
  const end = date(
    input.reportingPeriodEnd, 'PERIOD_INVALID', 'reportingPeriodEnd',
  );
  if (end < start) {
    throw new ChiefOfStaffPlanningError(
      'PERIOD_INVALID',
      'reporting period end precedes start',
    );
  }
  const recordType = optionalString(
    input.recordType, 'RECORD_TYPE_INVALID', 'recordType', 9, 30,
  );
  if (recordType && !RECORD_TYPES.has(recordType)) {
    throw new ChiefOfStaffPlanningError(
      'RECORD_TYPE_INVALID',
      'recordType is unsupported',
    );
  }
  const ownerType = optionalString(
    input.ownerType, 'OWNER_TYPE_INVALID', 'ownerType', 5, 7,
  );
  let ownerId = null;
  if (ownerType) {
    if (!['human', 'agent', 'service'].includes(ownerType)) {
      throw new ChiefOfStaffPlanningError(
        'OWNER_TYPE_INVALID',
        'ownerType is unsupported',
      );
    }
    ownerId = ownerType === 'human'
      ? uuid(input.ownerId, 'OWNER_ID_INVALID', 'ownerId')
      : string(input.ownerId, 'OWNER_ID_INVALID', 'ownerId', 2, 160);
  }
  const payload = input.recordPayload ?? {};
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ChiefOfStaffPlanningError(
      'RECORD_PAYLOAD_INVALID',
      'recordPayload must be an object',
    );
  }
  if (command === 'create_record' && recordType === 'company_goal'
      && !Array.isArray(payload.kpis)) {
    throw new ChiefOfStaffPlanningError(
      'GOAL_KPIS_REQUIRED',
      'company goals require a KPI array',
    );
  }
  const sourceGoalId = optionalUuid(
    input.sourceGoalId, 'SOURCE_GOAL_INVALID', 'sourceGoalId',
  );
  const targetGoalId = optionalUuid(
    input.targetGoalId, 'TARGET_GOAL_INVALID', 'targetGoalId',
  );
  if (recordType === 'dependency'
      && (!sourceGoalId || !targetGoalId || sourceGoalId === targetGoalId)) {
    throw new ChiefOfStaffPlanningError(
      'DEPENDENCY_IDENTITY_INVALID',
      'dependencies require two distinct goal IDs',
    );
  }
  const args = {
    p_tenant_id: base.tenantId,
    p_cycle_id: uuid(input.cycleId, 'CYCLE_ID_INVALID', 'cycleId'),
    p_command: command,
    p_record_id: optionalUuid(input.recordId, 'RECORD_ID_INVALID', 'recordId'),
    p_record_type: recordType,
    p_title: optionalString(input.title, 'TITLE_INVALID', 'title', 3, 240),
    p_department: optionalString(
      input.department, 'DEPARTMENT_INVALID', 'department', 5, 50,
    ),
    p_owner_type: ownerType,
    p_owner_id: ownerId,
    p_source_goal_id: sourceGoalId,
    p_target_goal_id: targetGoalId,
    p_due_at: optionalTimestamp(input.dueAt, 'DUE_AT_INVALID', 'dueAt'),
    p_record_payload: payload,
    p_reporting_period_start: start,
    p_reporting_period_end: end,
    p_reliability_report_id: uuid(
      input.reliabilityReportId,
      'RELIABILITY_REPORT_REQUIRED',
      'reliabilityReportId',
    ),
    p_revenue_report_id: uuid(
      input.revenueReportId, 'REVENUE_REPORT_REQUIRED', 'revenueReportId',
    ),
    p_expected_revision: base.expectedRevision,
    p_idempotency_key: base.idempotencyKey,
    p_actor_type: base.actorType,
    p_actor_id: base.actorId,
    p_authority_tier: base.authorityTier,
    p_evidence: base.evidence,
    p_feature_gate_enabled: base.featureGateEnabled,
  };
  args.p_request_fingerprint = fingerprint(args);
  return {
    rpc: 'chief_of_staff_command_rpc',
    args,
    safety: {
      executionMode: 'supervised_read_only',
      requiredAcceptedReports: [
        'reliability_security_agent_ops',
        'revenue_sales',
      ],
      productionActionsAllowed: false,
      performsIo: false,
    },
  };
}

function verifyPlanFingerprint(plan) {
  if (!plan || !plan.args) return false;
  const { p_request_fingerprint: supplied, ...args } = plan.args;
  return SHA_RE.test(supplied) && fingerprint(args) === supplied;
}

module.exports = {
  ChiefOfStaffPlanningError,
  planDepartmentReportCommand,
  planChiefOfStaffCommand,
  verifyPlanFingerprint,
};
