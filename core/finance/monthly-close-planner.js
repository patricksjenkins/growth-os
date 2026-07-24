'use strict';

/**
 * Pure planner for migration 081's shadow/supervised monthly-close RPC.
 *
 * It performs no database, file, export-provider, notification, or ledger I/O.
 * It never calculates finance totals. The planner only validates and
 * fingerprints a command against an exact tenant/period/currency identity.
 */

const crypto = require('node:crypto');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const CODE_PATTERN = /^[a-z][a-z0-9_]{2,79}$/;
const ACTIONS = new Set([
  'begin_close',
  'raise_exception',
  'accept_task',
  'escalate_task',
  'complete_task',
  'record_reconciliation',
  'reviewer_approve',
  'sign_off',
  'record_export',
  'record_shadow_lock',
]);
const ACTOR_TYPES = new Set(['human', 'service', 'system']);
const AUTHORITY_TIERS = new Set(['system', 'finance_operator', 'owner']);
const FORBIDDEN_INPUT_KEYS = new Set([
  'entries',
  'financeEntries',
  'rawPayload',
  'payload',
  'providerToken',
  'secret',
  'customerEmail',
  'customerName',
  'bankAccount',
]);

class FinanceClosePlanningError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FinanceClosePlanningError';
    this.code = code;
  }
}

function requiredString(value, code, label, minimum = 1, maximum = 200) {
  const normalized = String(value || '').trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new FinanceClosePlanningError(code, `${label} has an invalid length`);
  }
  return normalized;
}

function uuid(value, code, label) {
  const normalized = requiredString(value, code, label, 36, 36).toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    throw new FinanceClosePlanningError(code, `${label} must be a UUID`);
  }
  return normalized;
}

function optionalUuid(value, code, label) {
  if (value === undefined || value === null || value === '') return null;
  return uuid(value, code, label);
}

function timestamp(value, code, label) {
  const normalized = requiredString(value, code, label, 20, 40);
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    throw new FinanceClosePlanningError(code, `${label} must be an ISO timestamp`);
  }
  return new Date(parsed).toISOString();
}

function optionalTimestamp(value, code, label) {
  if (value === undefined || value === null || value === '') return null;
  return timestamp(value, code, label);
}

function periodStart(value) {
  const normalized = requiredString(
    value,
    'PERIOD_START_INVALID',
    'periodStart',
    10,
    10,
  );
  if (!/^\d{4}-(0[1-9]|1[0-2])-01$/.test(normalized)) {
    throw new FinanceClosePlanningError(
      'PERIOD_START_INVALID',
      'periodStart must be the first day of a calendar month',
    );
  }
  return normalized;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeEvidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new FinanceClosePlanningError(
      'EVIDENCE_REQUIRED',
      'evidence must be a structured object',
    );
  }
  const normalized = {
    ...value,
    source_type: requiredString(
      value.source_type,
      'EVIDENCE_SOURCE_TYPE_INVALID',
      'evidence.source_type',
      3,
      60,
    ),
    source_id: requiredString(
      value.source_id,
      'EVIDENCE_SOURCE_ID_INVALID',
      'evidence.source_id',
      3,
      240,
    ),
    observed_at: timestamp(
      value.observed_at,
      'EVIDENCE_TIME_INVALID',
      'evidence.observed_at',
    ),
  };
  return normalized;
}

function normalizeActor(input) {
  const actorType = requiredString(
    input.actorType,
    'ACTOR_TYPE_INVALID',
    'actorType',
    5,
    7,
  ).toLowerCase();
  const authorityTier = requiredString(
    input.authorityTier,
    'AUTHORITY_TIER_INVALID',
    'authorityTier',
    5,
    20,
  ).toLowerCase();
  if (!ACTOR_TYPES.has(actorType) || !AUTHORITY_TIERS.has(authorityTier)) {
    throw new FinanceClosePlanningError(
      'ACTOR_AUTHORITY_INVALID',
      'actor type or authority tier is unsupported',
    );
  }

  let actorId = null;
  if (actorType === 'human') {
    actorId = uuid(input.actorId, 'ACTOR_ID_INVALID', 'actorId');
    if (!['finance_operator', 'owner'].includes(authorityTier)) {
      throw new FinanceClosePlanningError(
        'HUMAN_AUTHORITY_INVALID',
        'human actors require finance_operator or owner authority',
      );
    }
  } else if (actorType === 'service') {
    actorId = requiredString(
      input.actorId,
      'ACTOR_ID_INVALID',
      'actorId',
      2,
      160,
    );
    if (!['system', 'finance_operator'].includes(authorityTier)) {
      throw new FinanceClosePlanningError(
        'SERVICE_AUTHORITY_INVALID',
        'service actors require system or finance_operator authority',
      );
    }
  } else if (
    (input.actorId !== undefined && input.actorId !== null && input.actorId !== '')
    || authorityTier !== 'system'
  ) {
    throw new FinanceClosePlanningError(
      'SYSTEM_ACTOR_INVALID',
      'system actors cannot claim an actor id or elevated authority',
    );
  }

  return { actorType, actorId, authorityTier };
}

function normalizeReconciliationIds(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new FinanceClosePlanningError(
      'RECONCILIATION_IDS_INVALID',
      'reconciliationRecordIds must be an array',
    );
  }
  const ids = value.map((item) => (
    uuid(item, 'RECONCILIATION_ID_INVALID', 'reconciliationRecordId')
  ));
  if (new Set(ids).size !== ids.length) {
    throw new FinanceClosePlanningError(
      'RECONCILIATION_IDS_DUPLICATE',
      'reconciliationRecordIds cannot contain duplicates',
    );
  }
  return ids;
}

function planMonthlyFinanceCloseCommand(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new FinanceClosePlanningError('COMMAND_REQUIRED', 'command input is required');
  }
  for (const key of FORBIDDEN_INPUT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      throw new FinanceClosePlanningError(
        'FORBIDDEN_SENSITIVE_INPUT',
        `monthly-close commands must not contain ${key}`,
      );
    }
  }

  const action = requiredString(
    input.action,
    'ACTION_INVALID',
    'action',
    3,
    40,
  ).toLowerCase();
  if (!ACTIONS.has(action)) {
    throw new FinanceClosePlanningError('ACTION_INVALID', 'action is unsupported');
  }
  const tenantId = uuid(input.tenantId, 'TENANT_ID_INVALID', 'tenantId');
  const cycleId = uuid(input.cycleId, 'CYCLE_ID_INVALID', 'cycleId');
  const normalizedPeriodStart = periodStart(input.periodStart);
  const currency = requiredString(
    input.currency,
    'CURRENCY_INVALID',
    'currency',
    3,
    3,
  ).toUpperCase();
  if (!CURRENCY_PATTERN.test(currency)) {
    throw new FinanceClosePlanningError(
      'CURRENCY_INVALID',
      'currency must be an ISO-style three-letter code',
    );
  }
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new FinanceClosePlanningError(
      'EXPECTED_REVISION_INVALID',
      'expectedRevision must be a non-negative safe integer',
    );
  }
  const idempotencyKey = requiredString(
    input.idempotencyKey,
    'IDEMPOTENCY_KEY_INVALID',
    'idempotencyKey',
    8,
    200,
  );
  const evidence = normalizeEvidence(input.evidence);
  const targetId = optionalUuid(input.targetId, 'TARGET_ID_INVALID', 'targetId');
  const assigneeId = optionalUuid(
    input.assigneeId,
    'ASSIGNEE_ID_INVALID',
    'assigneeId',
  );
  const dueAt = optionalTimestamp(input.dueAt, 'DUE_AT_INVALID', 'dueAt');
  const exceptionCode = input.exceptionCode === undefined
    || input.exceptionCode === null
    || input.exceptionCode === ''
    ? null
    : requiredString(
      input.exceptionCode,
      'EXCEPTION_CODE_INVALID',
      'exceptionCode',
      3,
      80,
    ).toLowerCase();
  if (exceptionCode !== null && !CODE_PATTERN.test(exceptionCode)) {
    throw new FinanceClosePlanningError(
      'EXCEPTION_CODE_INVALID',
      'exceptionCode must be a lower-case machine code',
    );
  }
  const reconciliationRecordIds = normalizeReconciliationIds(
    input.reconciliationRecordIds,
  );
  const actor = normalizeActor(input);

  if (action === 'begin_close' && input.expectedRevision !== 0) {
    throw new FinanceClosePlanningError(
      'BEGIN_REVISION_INVALID',
      'begin_close requires revision zero',
    );
  }
  if (action === 'raise_exception') {
    if (!targetId || !assigneeId || !dueAt || !exceptionCode) {
      throw new FinanceClosePlanningError(
        'EXCEPTION_CONTRACT_INCOMPLETE',
        'raise_exception requires targetId, assigneeId, dueAt, and exceptionCode',
      );
    }
    if (Date.parse(dueAt) <= Date.parse(evidence.observed_at)) {
      throw new FinanceClosePlanningError(
        'EXCEPTION_DUE_AT_INVALID',
        'exception dueAt must be after the evidence observation',
      );
    }
  }
  if (['accept_task', 'escalate_task', 'complete_task'].includes(action) && !targetId) {
    throw new FinanceClosePlanningError(
      'TASK_ID_REQUIRED',
      `${action} requires targetId`,
    );
  }
  if (action === 'escalate_task' && !exceptionCode) {
    throw new FinanceClosePlanningError(
      'ESCALATION_CODE_REQUIRED',
      'escalate_task requires exceptionCode as the escalation code',
    );
  }
  if (
    ['accept_task', 'complete_task', 'reviewer_approve'].includes(action)
    && actor.actorType !== 'human'
  ) {
    throw new FinanceClosePlanningError(
      'HUMAN_ACTION_REQUIRED',
      `${action} requires a human actor`,
    );
  }
  if (
    ['sign_off', 'record_shadow_lock'].includes(action)
    && (actor.actorType !== 'human' || actor.authorityTier !== 'owner')
  ) {
    throw new FinanceClosePlanningError(
      'OWNER_ACTION_REQUIRED',
      `${action} requires a human owner actor`,
    );
  }
  if (action === 'record_reconciliation' && reconciliationRecordIds.length === 0) {
    throw new FinanceClosePlanningError(
      'RECONCILIATION_IDS_REQUIRED',
      'record_reconciliation requires at least one evidence record id',
    );
  }
  if (action !== 'record_reconciliation' && reconciliationRecordIds.length > 0) {
    throw new FinanceClosePlanningError(
      'RECONCILIATION_IDS_FORBIDDEN',
      'reconciliation record ids belong only on record_reconciliation',
    );
  }

  const semantic = {
    contractVersion: 1,
    tenantId,
    cycleId,
    periodStart: normalizedPeriodStart,
    currency,
    action,
    expectedRevision: input.expectedRevision,
    idempotencyKey,
    ...actor,
    evidence,
    targetId,
    exceptionCode,
    assigneeId,
    dueAt,
    reconciliationRecordIds,
  };

  return {
    rpc: 'finance_close_command_rpc',
    args: {
      p_tenant_id: semantic.tenantId,
      p_cycle_id: semantic.cycleId,
      p_period_start: semantic.periodStart,
      p_currency: semantic.currency,
      p_action: semantic.action,
      p_expected_revision: semantic.expectedRevision,
      p_idempotency_key: semantic.idempotencyKey,
      p_request_fingerprint: sha256(stableJson(semantic)),
      p_actor_type: semantic.actorType,
      p_actor_id: semantic.actorId,
      p_authority_tier: semantic.authorityTier,
      p_evidence: semantic.evidence,
      // Deliberately false: runtime activation requires explicit configuration
      // outside this pure planner and the database tenant containment row.
      p_feature_gate_enabled: false,
      p_target_id: semantic.targetId,
      p_exception_code: semantic.exceptionCode,
      p_assignee_id: semantic.assigneeId,
      p_due_at: semantic.dueAt,
      p_reconciliation_record_ids: semantic.reconciliationRecordIds,
    },
    safety: {
      executionMode: 'shadow',
      providerExportAllowed: false,
      productionPeriodLockAllowed: false,
      performsIo: false,
    },
  };
}

function verifyRequestFingerprint(plan) {
  return Boolean(
    plan
    && plan.rpc === 'finance_close_command_rpc'
    && DIGEST_PATTERN.test(plan.args && plan.args.p_request_fingerprint),
  );
}

module.exports = {
  ACTIONS,
  FinanceClosePlanningError,
  planMonthlyFinanceCloseCommand,
  verifyRequestFingerprint,
};
