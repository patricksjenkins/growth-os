'use strict';

const crypto = require('node:crypto');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ACTION_TYPES = new Set([
  'call_review',
  'meeting_follow_up',
  'proposal_follow_up',
  'email_follow_up',
  'sms_follow_up',
  'qualification',
  'sales_task',
  'other',
]);
const COMMANDS = new Set([
  'assign',
  'accept',
  'escalate',
  'complete',
  'record_outcome',
]);
const ACTOR_TYPES = new Set(['human', 'agent', 'service', 'system']);
const AUTHORITY_TIERS = new Set([
  'system',
  'sales_operator',
  'department_head',
  'owner',
]);
const FORBIDDEN_KEYS = new Set([
  'to',
  'phone',
  'email',
  'customerEmail',
  'customerPhone',
  'message',
  'messageBody',
  'body',
  'provider',
  'providerPayload',
  'providerToken',
  'send',
  'dispatch',
  'causal',
  'causedBy',
  'causalEffect',
  'incrementalLift',
]);

class LeadActionPlanningError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LeadActionPlanningError';
    this.code = code;
  }
}

function requiredString(value, code, label, min = 1, max = 240) {
  if (typeof value !== 'string') {
    throw new LeadActionPlanningError(code, `${label} must be a string`);
  }
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) {
    throw new LeadActionPlanningError(
      code,
      `${label} must be between ${min} and ${max} characters`,
    );
  }
  return normalized;
}

function optionalString(value, code, label, min = 1, max = 240) {
  if (value === undefined || value === null || value === '') return null;
  return requiredString(value, code, label, min, max);
}

function uuid(value, code, label) {
  const normalized = requiredString(value, code, label, 36, 36).toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    throw new LeadActionPlanningError(code, `${label} must be a UUID`);
  }
  return normalized;
}

function integer(value, code, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new LeadActionPlanningError(
      code,
      `${label} must be a non-negative safe integer`,
    );
  }
  return value;
}

function timestamp(value, code, label) {
  const normalized = requiredString(value, code, label, 20, 40);
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    throw new LeadActionPlanningError(code, `${label} must be an ISO timestamp`);
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
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function assertNoForbiddenKeys(value, path = 'command') {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenKeys(item, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new LeadActionPlanningError(
        'FORBIDDEN_INPUT',
        `${path}.${key} is not accepted by the evidence-only planner`,
      );
    }
    assertNoForbiddenKeys(child, `${path}.${key}`);
  }
}

function normalizeEvidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LeadActionPlanningError(
      'EVIDENCE_REQUIRED',
      'evidence must be a structured object',
    );
  }
  return {
    ...value,
    source_type: requiredString(
      value.source_type,
      'EVIDENCE_SOURCE_TYPE_INVALID',
      'evidence.source_type',
      3,
      80,
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
    throw new LeadActionPlanningError(
      'ACTOR_AUTHORITY_INVALID',
      'actor type or authority tier is unsupported',
    );
  }

  let actorId = null;
  if (actorType === 'human') {
    actorId = uuid(input.actorId, 'ACTOR_ID_INVALID', 'actorId');
  } else if (actorType === 'agent' || actorType === 'service') {
    actorId = requiredString(
      input.actorId,
      'ACTOR_ID_INVALID',
      'actorId',
      2,
      160,
    );
    if (authorityTier === 'owner') {
      throw new LeadActionPlanningError(
        'SERVICE_AUTHORITY_INVALID',
        'non-human actors cannot claim owner authority',
      );
    }
  } else if (
    (input.actorId !== undefined && input.actorId !== null && input.actorId !== '')
    || authorityTier !== 'system'
  ) {
    throw new LeadActionPlanningError(
      'SYSTEM_ACTOR_INVALID',
      'system actors cannot claim an actor id or elevated authority',
    );
  }

  return { actorType, actorId, authorityTier };
}

function planLeadActionCommand(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new LeadActionPlanningError(
      'COMMAND_REQUIRED',
      'lead-action command input is required',
    );
  }
  assertNoForbiddenKeys(input);

  const tenantId = uuid(input.tenantId, 'TENANT_ID_INVALID', 'tenantId');
  const leadId = uuid(input.leadId, 'LEAD_ID_INVALID', 'leadId');
  const leadActionId = uuid(
    input.leadActionId,
    'LEAD_ACTION_ID_INVALID',
    'leadActionId',
  );
  const actionType = requiredString(
    input.actionType,
    'ACTION_TYPE_INVALID',
    'actionType',
    3,
    40,
  ).toLowerCase();
  const command = requiredString(
    input.command,
    'COMMAND_INVALID',
    'command',
    3,
    40,
  ).toLowerCase();
  if (!ACTION_TYPES.has(actionType)) {
    throw new LeadActionPlanningError(
      'ACTION_TYPE_INVALID',
      'actionType is unsupported',
    );
  }
  if (!COMMANDS.has(command)) {
    throw new LeadActionPlanningError(
      'COMMAND_INVALID',
      'command is unsupported',
    );
  }

  const expectedRevision = integer(
    input.expectedRevision,
    'REVISION_INVALID',
    'expectedRevision',
  );
  const idempotencyKey = requiredString(
    input.idempotencyKey,
    'IDEMPOTENCY_KEY_INVALID',
    'idempotencyKey',
    8,
    200,
  );
  const evidence = normalizeEvidence(input.evidence);
  const { actorType, actorId, authorityTier } = normalizeActor(input);

  let assigneeType = null;
  let assigneeId = null;
  let dueAt = null;
  let outcomeDueAt = null;
  let cohortKey = null;
  let assignmentSourceType = null;
  let assignmentSourceId = null;
  let escalationCode = null;
  let completionDisposition = null;
  let outcomeState = null;
  let attributionState = null;
  let outcomeSourceType = null;
  let outcomeSourceId = null;

  if (command === 'assign') {
    if (expectedRevision !== 0) {
      throw new LeadActionPlanningError(
        'ASSIGNMENT_REVISION_INVALID',
        'new assignments require expectedRevision 0',
      );
    }
    assigneeType = requiredString(
      input.assigneeType,
      'ASSIGNEE_TYPE_INVALID',
      'assigneeType',
      5,
      7,
    ).toLowerCase();
    if (!['human', 'agent', 'service'].includes(assigneeType)) {
      throw new LeadActionPlanningError(
        'ASSIGNEE_TYPE_INVALID',
        'assigneeType is unsupported',
      );
    }
    assigneeId = assigneeType === 'human'
      ? uuid(input.assigneeId, 'ASSIGNEE_ID_INVALID', 'assigneeId')
      : requiredString(
        input.assigneeId,
        'ASSIGNEE_ID_INVALID',
        'assigneeId',
        2,
        160,
      );
    dueAt = timestamp(input.dueAt, 'DUE_AT_INVALID', 'dueAt');
    outcomeDueAt = timestamp(
      input.outcomeDueAt,
      'OUTCOME_DUE_AT_INVALID',
      'outcomeDueAt',
    );
    if (Date.parse(outcomeDueAt) < Date.parse(dueAt)) {
      throw new LeadActionPlanningError(
        'OUTCOME_DUE_AT_INVALID',
        'outcomeDueAt cannot precede dueAt',
      );
    }
    cohortKey = requiredString(
      input.cohortKey,
      'COHORT_KEY_INVALID',
      'cohortKey',
      3,
      80,
    ).toLowerCase();
    if (!/^[a-z0-9][a-z0-9_.:-]{2,79}$/.test(cohortKey)) {
      throw new LeadActionPlanningError(
        'COHORT_KEY_INVALID',
        'cohortKey has an invalid format',
      );
    }
    assignmentSourceType = requiredString(
      input.assignmentSourceType,
      'ASSIGNMENT_SOURCE_TYPE_INVALID',
      'assignmentSourceType',
      3,
      80,
    );
    assignmentSourceId = requiredString(
      input.assignmentSourceId,
      'ASSIGNMENT_SOURCE_ID_INVALID',
      'assignmentSourceId',
      3,
      240,
    );
  } else if (command === 'escalate') {
    escalationCode = requiredString(
      input.escalationCode,
      'ESCALATION_CODE_INVALID',
      'escalationCode',
      3,
      80,
    ).toLowerCase();
    if (!/^[a-z][a-z0-9_]{2,79}$/.test(escalationCode)) {
      throw new LeadActionPlanningError(
        'ESCALATION_CODE_INVALID',
        'escalationCode has an invalid format',
      );
    }
  } else if (command === 'complete') {
    completionDisposition = requiredString(
      input.completionDisposition,
      'COMPLETION_DISPOSITION_INVALID',
      'completionDisposition',
      7,
      14,
    ).toLowerCase();
    if (!['performed', 'not_applicable', 'blocked'].includes(
      completionDisposition,
    )) {
      throw new LeadActionPlanningError(
        'COMPLETION_DISPOSITION_INVALID',
        'completionDisposition is unsupported',
      );
    }
  } else if (command === 'record_outcome') {
    outcomeState = requiredString(
      input.outcomeState,
      'OUTCOME_STATE_INVALID',
      'outcomeState',
      7,
      13,
    ).toLowerCase();
    if (!['converted', 'not_converted', 'unknown'].includes(outcomeState)) {
      throw new LeadActionPlanningError(
        'OUTCOME_STATE_INVALID',
        'outcomeState is unsupported',
      );
    }
    attributionState = requiredString(
      input.attributionState,
      'ATTRIBUTION_STATE_INVALID',
      'attributionState',
      7,
      8,
    ).toLowerCase();
    if (outcomeState === 'unknown') {
      if (
        attributionState !== 'unknown'
        || input.outcomeSourceType !== undefined
        || input.outcomeSourceId !== undefined
      ) {
        throw new LeadActionPlanningError(
          'UNKNOWN_ATTRIBUTION_INVALID',
          'unknown outcomes cannot include an observed source',
        );
      }
    } else {
      if (attributionState !== 'observed') {
        throw new LeadActionPlanningError(
          'OBSERVED_ATTRIBUTION_REQUIRED',
          'known outcomes require observed attribution',
        );
      }
      outcomeSourceType = requiredString(
        input.outcomeSourceType,
        'OUTCOME_SOURCE_TYPE_INVALID',
        'outcomeSourceType',
        3,
        80,
      );
      outcomeSourceId = requiredString(
        input.outcomeSourceId,
        'OUTCOME_SOURCE_ID_INVALID',
        'outcomeSourceId',
        3,
        240,
      );
    }
  }

  const argsWithoutFingerprint = {
    p_tenant_id: tenantId,
    p_lead_id: leadId,
    p_lead_action_id: leadActionId,
    p_action_type: actionType,
    p_command: command,
    p_expected_revision: expectedRevision,
    p_idempotency_key: idempotencyKey,
    p_actor_type: actorType,
    p_actor_id: actorId,
    p_authority_tier: authorityTier,
    p_evidence: evidence,
    p_feature_gate_enabled: input.featureGateEnabled === true,
    p_assignee_type: assigneeType,
    p_assignee_id: assigneeId,
    p_due_at: dueAt,
    p_outcome_due_at: outcomeDueAt,
    p_cohort_key: cohortKey,
    p_assignment_source_type: assignmentSourceType,
    p_assignment_source_id: assignmentSourceId,
    p_escalation_code: escalationCode,
    p_completion_disposition: completionDisposition,
    p_outcome_state: outcomeState,
    p_attribution_state: attributionState,
    p_outcome_source_type: outcomeSourceType,
    p_outcome_source_id: outcomeSourceId,
  };
  const requestFingerprint = sha256(stableJson(argsWithoutFingerprint));

  return {
    rpc: 'lead_action_command_rpc',
    args: {
      ...argsWithoutFingerprint,
      p_request_fingerprint: requestFingerprint,
    },
    safety: {
      executionMode: 'shadow',
      outreachAllowed: false,
      providerDispatchAllowed: false,
      causalClaimAllowed: false,
      performsIo: false,
    },
  };
}

function verifyRequestFingerprint(plan) {
  if (!plan || plan.rpc !== 'lead_action_command_rpc' || !plan.args) {
    return false;
  }
  const {
    p_request_fingerprint: fingerprint,
    ...argsWithoutFingerprint
  } = plan.args;
  return SHA256_PATTERN.test(fingerprint)
    && sha256(stableJson(argsWithoutFingerprint)) === fingerprint;
}

module.exports = {
  LeadActionPlanningError,
  planLeadActionCommand,
  verifyRequestFingerprint,
};
