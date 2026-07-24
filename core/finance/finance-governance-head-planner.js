'use strict';

const crypto = require('node:crypto');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA_RE = /^[a-f0-9]{64}$/;
const FORBIDDEN_NORMALIZED = new Set([
  'charge', 'refund', 'transfer', 'moneymovement', 'providerdispatch',
  'pricingchange', 'periodlock', 'export', 'productionwrite', 'send',
  'publish', 'customeremail', 'customerphone', 'providertoken',
  'revenueminor', 'costminor', 'marginminor', 'financialtruthstate',
  'reconciliationstate', 'monthlyclosestate', 'authorization', 'apikey',
  'accesstoken', 'refreshtoken', 'password', 'secret', 'credential',
  'cookie', 'setcookie', 'privatekey', 'clientsecret',
]);
const EVIDENCE_KEYS = new Set([
  'source_type', 'source_id', 'observed_at', 'evidence_digest',
]);
const OPAQUE_METADATA_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,159}$/;

class FinanceGovernancePlanningError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FinanceGovernancePlanningError';
    this.code = code;
  }
}

function str(value, code, label, min = 1, max = 240) {
  if (typeof value !== 'string') {
    throw new FinanceGovernancePlanningError(code, `${label} must be a string`);
  }
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) {
    throw new FinanceGovernancePlanningError(code, `${label} length is invalid`);
  }
  return normalized;
}

function optionalStr(value, code, label, min = 1, max = 240) {
  if (value === undefined || value === null || value === '') return null;
  return str(value, code, label, min, max);
}

function uuid(value, code, label) {
  const normalized = str(value, code, label, 36, 36).toLowerCase();
  if (!UUID_RE.test(normalized)) {
    throw new FinanceGovernancePlanningError(code, `${label} must be a UUID`);
  }
  return normalized;
}

function optionalUuid(value, code, label) {
  if (value === undefined || value === null || value === '') return null;
  return uuid(value, code, label);
}

function timestamp(value, code, label) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = str(value, code, label, 20, 40);
  if (!Number.isFinite(Date.parse(normalized))) {
    throw new FinanceGovernancePlanningError(code, `${label} is invalid`);
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
      throw new FinanceGovernancePlanningError(
        'PRODUCTION_ACTION_FORBIDDEN',
        `${path}.${key} is forbidden`,
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
    throw new FinanceGovernancePlanningError(
      'EVIDENCE_REQUIRED', 'evidence must be an object',
    );
  }
  for (const key of Object.keys(value)) {
    if (!EVIDENCE_KEYS.has(key) || typeof value[key] !== 'string') {
      throw new FinanceGovernancePlanningError(
        'EVIDENCE_SCHEMA_INVALID',
        `evidence.${key} is not in the minimized evidence schema`,
      );
    }
  }
  const observedAt = timestamp(
    value.observed_at, 'EVIDENCE_TIME_INVALID', 'evidence.observed_at',
  );
  if (!observedAt) {
    throw new FinanceGovernancePlanningError(
      'EVIDENCE_TIME_INVALID', 'evidence.observed_at is required',
    );
  }
  const minimized = {
    source_type: str(
      value.source_type, 'EVIDENCE_SOURCE_INVALID', 'evidence.source_type', 3, 80,
    ),
    source_id: str(
      value.source_id, 'EVIDENCE_ID_INVALID', 'evidence.source_id', 3, 240,
    ),
    observed_at: observedAt,
  };
  if (value.evidence_digest !== undefined) {
    minimized.evidence_digest = str(
      value.evidence_digest,
      'EVIDENCE_DIGEST_INVALID',
      'evidence.evidence_digest',
      64,
      64,
    );
    if (!SHA_RE.test(minimized.evidence_digest)) {
      throw new FinanceGovernancePlanningError(
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

function opaqueMetadataValue(value) {
  return typeof value === 'string' && OPAQUE_METADATA_VALUE.test(value);
}

function structuredReport(value) {
  if (!exactKeys(value, ['controls_tested', 'exceptions'])
      || !Number.isSafeInteger(value.controls_tested)
      || value.controls_tested < 0
      || !Number.isSafeInteger(value.exceptions)
      || value.exceptions < 0) {
    throw new FinanceGovernancePlanningError(
      'REPORT_METADATA_INVALID',
      'structuredReport must contain only non-negative controls_tested and exceptions',
    );
  }
  return {
    controls_tested: value.controls_tested,
    exceptions: value.exceptions,
  };
}

function caseContract(caseType, value) {
  if (caseType === 'goal'
      && exactKeys(value, ['measure'])
      && opaqueMetadataValue(value.measure)) {
    return { measure: value.measure };
  }
  if (caseType === 'work'
      && exactKeys(value, ['acceptance'])
      && Array.isArray(value.acceptance)
      && value.acceptance.length >= 1
      && value.acceptance.length <= 20
      && value.acceptance.every(opaqueMetadataValue)) {
    return { acceptance: [...value.acceptance] };
  }
  if (caseType === 'decision'
      && exactKeys(value, ['decision_scope'])
      && opaqueMetadataValue(value.decision_scope)) {
    return { decision_scope: value.decision_scope };
  }
  if (caseType === 'exception'
      && exactKeys(value, ['resolution'])
      && opaqueMetadataValue(value.resolution)) {
    return { resolution: value.resolution };
  }
  throw new FinanceGovernancePlanningError(
    'CASE_METADATA_INVALID',
    'contract does not match the documented case-type schema',
  );
}

function planFinanceGovernanceHeadCommand(input = {}) {
  rejectForbidden(input);
  const command = str(
    input.command, 'COMMAND_INVALID', 'command', 10, 30,
  ).toLowerCase();
  if (![
    'accept_report', 'create_case', 'accept_work', 'escalate_work',
    'complete_work', 'record_outcome', 'complete_goal',
    'decide_decision', 'resolve_exception',
  ].includes(command)) {
    throw new FinanceGovernancePlanningError(
      'COMMAND_INVALID', 'unsupported command',
    );
  }
  if (!Number.isSafeInteger(input.expectedRevision)
      || input.expectedRevision < 0) {
    throw new FinanceGovernancePlanningError(
      'REVISION_INVALID', 'expectedRevision must be non-negative',
    );
  }
  const recordIds = input.attributionRecordIds ?? [];
  if (!Array.isArray(recordIds)) {
    throw new FinanceGovernancePlanningError(
      'ATTRIBUTION_IDS_INVALID', 'attributionRecordIds must be an array',
    );
  }
  const normalizedIds = recordIds.map((id) => (
    uuid(id, 'ATTRIBUTION_ID_INVALID', 'attributionRecordId')
  ));
  if (new Set(normalizedIds).size !== normalizedIds.length) {
    throw new FinanceGovernancePlanningError(
      'DUPLICATE_ATTRIBUTION_IDS', 'attribution IDs must be distinct',
    );
  }
  const normalizedEvidence = evidence(input.evidence);
  if (input.assigneeId !== undefined && input.assigneeId !== null
      && input.assigneeId !== '') {
    throw new FinanceGovernancePlanningError(
      'ASSIGNEE_ID_FORBIDDEN',
      'Finance Head work is explicitly assigned to the registered Head actor',
    );
  }
  const normalizedCaseType = command === 'create_case'
    ? str(input.caseType, 'CASE_TYPE_INVALID', 'caseType', 4, 9).toLowerCase()
    : optionalStr(input.caseType, 'CASE_TYPE_INVALID', 'caseType', 4, 9);
  let minimizedStructuredReport = {};
  let minimizedContract = {};
  if (command === 'accept_report') {
    minimizedStructuredReport = structuredReport(input.structuredReport);
    if (input.contract && Object.keys(input.contract).length > 0) {
      throw new FinanceGovernancePlanningError(
        'CASE_METADATA_INVALID', 'report commands cannot contain a case contract',
      );
    }
  } else if (command === 'create_case') {
    if (input.structuredReport && Object.keys(input.structuredReport).length > 0) {
      throw new FinanceGovernancePlanningError(
        'REPORT_METADATA_INVALID', 'case commands cannot contain report metadata',
      );
    }
    minimizedContract = caseContract(
      normalizedCaseType, input.contract,
    );
  } else if ((input.structuredReport && Object.keys(input.structuredReport).length > 0)
      || (input.contract && Object.keys(input.contract).length > 0)) {
    throw new FinanceGovernancePlanningError(
      'COMMAND_METADATA_INVALID',
      'transition commands accept only minimized evidence metadata',
    );
  }
  const args = {
    p_tenant_id: uuid(input.tenantId, 'TENANT_ID_INVALID', 'tenantId'),
    p_command: command,
    p_report_id: optionalUuid(input.reportId, 'REPORT_ID_INVALID', 'reportId'),
    p_case_id: optionalUuid(input.caseId, 'CASE_ID_INVALID', 'caseId'),
    p_finance_close_cycle_id: optionalUuid(
      input.financeCloseCycleId, 'CLOSE_CYCLE_INVALID', 'financeCloseCycleId',
    ),
    p_period_start: input.periodStart
      ? str(input.periodStart, 'PERIOD_INVALID', 'periodStart', 10, 10)
      : null,
    p_currency: input.currency
      ? str(input.currency, 'CURRENCY_INVALID', 'currency', 3, 3).toUpperCase()
      : null,
    p_attribution_record_ids: normalizedIds,
    p_execution_health: optionalStr(
      input.executionHealth, 'EXECUTION_HEALTH_INVALID', 'executionHealth', 6, 9,
    ),
    p_data_governance_state: optionalStr(
      input.dataGovernanceState,
      'GOVERNANCE_STATE_INVALID',
      'dataGovernanceState',
      8,
      10,
    ),
    p_governance_evidence_digest: optionalStr(
      input.governanceEvidenceDigest,
      'GOVERNANCE_DIGEST_INVALID',
      'governanceEvidenceDigest',
      64,
      64,
    ),
    p_structured_report: minimizedStructuredReport,
    p_case_type: normalizedCaseType,
    p_title: optionalStr(input.title, 'TITLE_INVALID', 'title', 3, 240),
    p_owner_id: optionalUuid(input.ownerId, 'OWNER_ID_INVALID', 'ownerId'),
    p_assignee_id: null,
    p_sla_due_at: timestamp(input.slaDueAt, 'SLA_INVALID', 'slaDueAt'),
    p_contract: minimizedContract,
    p_escalation_code: optionalStr(
      input.escalationCode, 'ESCALATION_INVALID', 'escalationCode', 3, 80,
    ),
    p_outcome_state: optionalStr(
      input.outcomeState, 'OUTCOME_INVALID', 'outcomeState', 8, 21,
    ),
    p_expected_revision: input.expectedRevision,
    p_idempotency_key: str(
      input.idempotencyKey, 'IDEMPOTENCY_INVALID', 'idempotencyKey', 8, 200,
    ),
    p_actor_id: str(
      input.actorId, 'ACTOR_ID_INVALID', 'actorId', 3, 160,
    ),
    p_authority_tier: 'department_head',
    p_evidence: normalizedEvidence,
    p_feature_gate_enabled: input.featureGateEnabled === true,
  };
  if (command === 'accept_report') {
    if (normalizedIds.length === 0
        || !args.p_finance_close_cycle_id
        || !args.p_report_id
        || !/^\d{4}-(0[1-9]|1[0-2])-01$/.test(args.p_period_start ?? '')
        || !/^[A-Z]{3}$/.test(args.p_currency ?? '')
        || !['succeeded', 'failed', 'unknown'].includes(args.p_execution_health)
        || !['verified', 'exception', 'unverified'].includes(
          args.p_data_governance_state,
        )
        || !SHA_RE.test(args.p_governance_evidence_digest ?? '')
        || !exactKeys(minimizedStructuredReport, [
          'controls_tested', 'exceptions',
        ])) {
      throw new FinanceGovernancePlanningError(
        'REPORT_CONTRACT_INVALID', 'report evidence contract is incomplete',
      );
    }
  }
  if (command === 'complete_goal' && ![
    'verified_achieved', 'verified_not_achieved',
  ].includes(args.p_outcome_state)) {
    throw new FinanceGovernancePlanningError(
      'OUTCOME_INVALID', 'goal outcome is invalid',
    );
  }
  if (command === 'decide_decision'
      && !['approved', 'rejected'].includes(args.p_outcome_state)) {
    throw new FinanceGovernancePlanningError(
      'OUTCOME_INVALID', 'decision result is invalid',
    );
  }
  if (command === 'resolve_exception' && ![
    'verified_achieved', 'verified_not_achieved',
  ].includes(args.p_outcome_state)) {
    throw new FinanceGovernancePlanningError(
      'OUTCOME_INVALID', 'exception outcome is invalid',
    );
  }
  const fingerprintArgs = { ...args };
  args.p_request_fingerprint = hash(stable(fingerprintArgs));
  return {
    rpc: 'finance_governance_head_command_rpc',
    args,
    safety: {
      executionMode: 'supervised_read_only',
      canonicalFinanceMutationAllowed: false,
      moneyMovementAllowed: false,
      providerActionsAllowed: false,
      performsIo: false,
    },
  };
}

function verifyPlanFingerprint(plan) {
  if (!plan || !plan.args) return false;
  const { p_request_fingerprint: supplied, ...args } = plan.args;
  return SHA_RE.test(supplied) && hash(stable(args)) === supplied;
}

module.exports = {
  FinanceGovernancePlanningError,
  planFinanceGovernanceHeadCommand,
  verifyPlanFingerprint,
};
