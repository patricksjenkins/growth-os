'use strict';

/**
 * Pure command planners for migration 086's supervised, read-only Revenue and
 * Sales Department Head. No function performs I/O or creates outreach.
 */

const crypto = require('node:crypto');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CODE = /^[a-z][a-z0-9_]{1,63}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,239}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const COMMANDS = new Set(['create', 'accept', 'start', 'escalate', 'complete', 'record_decision']);
const ITEM_KINDS = new Set(['goal', 'work', 'decision', 'exception']);
const ACTION_SCOPES = new Set([
  'analyze_funnel',
  'track_goal',
  'recommend_action',
  'request_owner_decision',
  'raise_exception',
  'verify_evidence',
]);
const FORBIDDEN_KEYS = new Set([
  'email', 'phone', 'to', 'recipient', 'message', 'body', 'send', 'dispatch',
  'provider', 'providerPayload', 'providerToken', 'price', 'pricing',
  'charge', 'refund', 'contract', 'rawPayload', 'customerName',
]);

class RevenueDepartmentHeadError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RevenueDepartmentHeadError';
    this.code = code;
  }
}

function requiredString(value, errorCode, label, min = 1, max = 240) {
  if (typeof value !== 'string') {
    throw new RevenueDepartmentHeadError(errorCode, `${label} must be a string`);
  }
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) {
    throw new RevenueDepartmentHeadError(errorCode, `${label} has an invalid length`);
  }
  return normalized;
}

function optionalString(value, errorCode, label, min = 1, max = 240) {
  if (value === null || value === undefined || value === '') return null;
  return requiredString(value, errorCode, label, min, max);
}

function uuid(value, errorCode, label, optional = false) {
  if (optional && (value === null || value === undefined || value === '')) return null;
  const normalized = requiredString(value, errorCode, label, 36, 36).toLowerCase();
  if (!UUID.test(normalized)) {
    throw new RevenueDepartmentHeadError(errorCode, `${label} must be a UUID`);
  }
  return normalized;
}

function code(value, errorCode, label) {
  const normalized = requiredString(value, errorCode, label, 2, 64).toLowerCase();
  if (!CODE.test(normalized)) {
    throw new RevenueDepartmentHeadError(errorCode, `${label} must be a lower-case code`);
  }
  return normalized;
}

function reference(value, errorCode, label) {
  const normalized = requiredString(value, errorCode, label, 2, 240);
  if (!REF.test(normalized) || normalized.includes('@')) {
    throw new RevenueDepartmentHeadError(errorCode, `${label} must be an opaque reference`);
  }
  return normalized;
}

function digest(value, errorCode, label) {
  const normalized = requiredString(value, errorCode, label, 64, 64).toLowerCase();
  if (!DIGEST.test(normalized)) {
    throw new RevenueDepartmentHeadError(errorCode, `${label} must be a sha256 digest`);
  }
  return normalized;
}

function timestamp(value, errorCode, label, optional = false) {
  if (optional && (value === null || value === undefined || value === '')) return null;
  const parsed = Date.parse(requiredString(value, errorCode, label, 20, 40));
  if (!Number.isFinite(parsed)) {
    throw new RevenueDepartmentHeadError(errorCode, `${label} must be an ISO timestamp`);
  }
  return new Date(parsed).toISOString();
}

function date(value, errorCode, label) {
  const normalized = requiredString(value, errorCode, label, 10, 10);
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)
      || Number.isNaN(parsed.getTime())
      || parsed.toISOString().slice(0, 10) !== normalized) {
    throw new RevenueDepartmentHeadError(errorCode, `${label} must be an ISO date`);
  }
  return normalized;
}

function integer(value, errorCode, label, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RevenueDepartmentHeadError(errorCode, `${label} must be a safe integer`);
  }
  return value;
}

function number(value, errorCode, label, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new RevenueDepartmentHeadError(errorCode, `${label} is outside its allowed range`);
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

function fingerprint(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

function assertNoForbiddenKeys(value, path = 'command') {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenKeys(item, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new RevenueDepartmentHeadError(
        'PROHIBITED_ACTION_INPUT',
        `${path}.${key} is outside supervised read-only authority`,
      );
    }
    assertNoForbiddenKeys(child, `${path}.${key}`);
  }
}

function evidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RevenueDepartmentHeadError('EVIDENCE_REQUIRED', 'evidence must be an object');
  }
  assertNoForbiddenKeys(value, 'evidence');
  if (value.schema_version !== 1 || !Array.isArray(value.sources)
      || value.sources.length < 1 || value.sources.length > 50) {
    throw new RevenueDepartmentHeadError(
      'EVIDENCE_CONTRACT_INVALID',
      'evidence requires schema_version 1 and 1-50 sources',
    );
  }
  const sources = value.sources.map((source) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      throw new RevenueDepartmentHeadError('EVIDENCE_SOURCE_INVALID', 'source must be an object');
    }
    return {
      source_type: code(source.source_type, 'EVIDENCE_SOURCE_INVALID', 'source_type'),
      source_id: reference(source.source_id, 'EVIDENCE_SOURCE_INVALID', 'source_id'),
      evidence_digest: digest(
        source.evidence_digest,
        'EVIDENCE_SOURCE_INVALID',
        'evidence_digest',
      ),
      observed_at: timestamp(source.observed_at, 'EVIDENCE_SOURCE_INVALID', 'observed_at'),
    };
  });
  const identities = new Set(
    sources.map(source => `${source.source_type}:${source.source_id}`),
  );
  if (identities.size !== sources.length) {
    throw new RevenueDepartmentHeadError(
      'EVIDENCE_SOURCE_DUPLICATE',
      'evidence source identities must be unique',
    );
  }
  return { schema_version: 1, sources };
}

function base(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new RevenueDepartmentHeadError('COMMAND_REQUIRED', 'command input is required');
  }
  assertNoForbiddenKeys(input);
  return {
    tenantId: uuid(input.tenantId, 'TENANT_ID_INVALID', 'tenantId'),
    idempotencyKey: requiredString(
      input.idempotencyKey,
      'IDEMPOTENCY_KEY_INVALID',
      'idempotencyKey',
      8,
      200,
    ),
  };
}

function gatedCommand(rpc, semantics, args) {
  return Object.freeze({
    rpc,
    args: Object.freeze({
      ...args,
      p_request_fingerprint: fingerprint(semantics),
      p_feature_gate_enabled: false,
    }),
  });
}

function planRevenueCharterRegistration(input) {
  const b = base(input);
  const actorId = uuid(input.actorId, 'ACTOR_ID_INVALID', 'actorId');
  const version = integer(input.version, 'CHARTER_VERSION_INVALID', 'version', 1, 1000000);
  const mission = requiredString(input.mission, 'MISSION_INVALID', 'mission', 40, 1000);
  const targets = {
    qualificationRateBps: integer(input.targets?.qualificationRateBps, 'KPI_INVALID', 'qualificationRateBps', 1, 10000),
    appointmentRateBps: integer(input.targets?.appointmentRateBps, 'KPI_INVALID', 'appointmentRateBps', 1, 10000),
    heldRateBps: integer(input.targets?.heldRateBps, 'KPI_INVALID', 'heldRateBps', 1, 10000),
    proposalRateBps: integer(input.targets?.proposalRateBps, 'KPI_INVALID', 'proposalRateBps', 1, 10000),
    winRateBps: integer(input.targets?.winRateBps, 'KPI_INVALID', 'winRateBps', 1, 10000),
    maxSalesCycleDays: integer(input.targets?.maxSalesCycleDays, 'KPI_INVALID', 'maxSalesCycleDays', 1, 3650),
  };
  const ev = evidence(input.evidence);
  const semantics = { ...b, actorId, version, mission, targets, evidence: ev };
  return gatedCommand('revenue_head_charter_register_rpc', semantics, {
    p_tenant_id: b.tenantId,
    p_version: version,
    p_mission: mission,
    p_qualification_rate_target_bps: targets.qualificationRateBps,
    p_appointment_rate_target_bps: targets.appointmentRateBps,
    p_held_rate_target_bps: targets.heldRateBps,
    p_proposal_rate_target_bps: targets.proposalRateBps,
    p_win_rate_target_bps: targets.winRateBps,
    p_max_sales_cycle_days: targets.maxSalesCycleDays,
    p_actor_id: actorId,
    p_evidence: ev,
    p_idempotency_key: b.idempotencyKey,
  });
}

function planRevenueReportAcceptance(input) {
  const b = base(input);
  const charterId = uuid(input.charterId, 'CHARTER_ID_INVALID', 'charterId');
  const reportId = uuid(input.reportId, 'REPORT_ID_INVALID', 'reportId');
  const periodStart = date(input.periodStart, 'PERIOD_INVALID', 'periodStart');
  const periodEnd = date(input.periodEnd, 'PERIOD_INVALID', 'periodEnd');
  if (periodEnd < periodStart) {
    throw new RevenueDepartmentHeadError('PERIOD_INVALID', 'periodEnd must not precede periodStart');
  }
  const metrics = {};
  for (const key of [
    'leadsCreated', 'qualifiedLeads', 'appointmentsBooked',
    'appointmentsHeld', 'proposalsSent', 'closedWon', 'closedLost',
  ]) {
    metrics[key] = integer(input.metrics?.[key], 'FUNNEL_METRIC_INVALID', key, 0, 1000000000);
  }
  if (metrics.qualifiedLeads > metrics.leadsCreated
      || metrics.appointmentsBooked > metrics.qualifiedLeads
      || metrics.appointmentsHeld > metrics.appointmentsBooked
      || metrics.proposalsSent > metrics.appointmentsHeld
      || metrics.closedWon + metrics.closedLost > metrics.proposalsSent) {
    throw new RevenueDepartmentHeadError(
      'FUNNEL_SEQUENCE_INVALID',
      'funnel stage counts must be monotonically non-increasing',
    );
  }
  metrics.averageSalesCycleDays = number(
    input.metrics?.averageSalesCycleDays,
    'FUNNEL_METRIC_INVALID',
    'averageSalesCycleDays',
    0,
    3650,
  );
  metrics.openPipelineMinor = integer(
    input.metrics?.openPipelineMinor,
    'FUNNEL_METRIC_INVALID',
    'openPipelineMinor',
    0,
  );
  metrics.bookedRevenueMinor = integer(
    input.metrics?.bookedRevenueMinor,
    'FUNNEL_METRIC_INVALID',
    'bookedRevenueMinor',
    0,
  );
  const ev = evidence(input.evidence);
  const sourceSystem = code(input.sourceSystem, 'SOURCE_SYSTEM_INVALID', 'sourceSystem');
  const sourceReportId = reference(input.sourceReportId, 'SOURCE_REPORT_ID_INVALID', 'sourceReportId');
  const currency = requiredString(input.currency, 'CURRENCY_INVALID', 'currency', 3, 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new RevenueDepartmentHeadError('CURRENCY_INVALID', 'currency must be ISO-4217');
  }
  const semantics = {
    ...b, charterId, reportId, periodStart, periodEnd, metrics,
    evidence: ev, sourceSystem, sourceReportId, currency,
  };
  return gatedCommand('revenue_head_report_accept_rpc', semantics, {
    p_tenant_id: b.tenantId,
    p_report_id: reportId,
    p_charter_id: charterId,
    p_period_start: periodStart,
    p_period_end: periodEnd,
    p_source_system: sourceSystem,
    p_source_report_id: sourceReportId,
    p_leads_created: metrics.leadsCreated,
    p_qualified_leads: metrics.qualifiedLeads,
    p_appointments_booked: metrics.appointmentsBooked,
    p_appointments_held: metrics.appointmentsHeld,
    p_proposals_sent: metrics.proposalsSent,
    p_closed_won: metrics.closedWon,
    p_closed_lost: metrics.closedLost,
    p_open_pipeline_minor: metrics.openPipelineMinor,
    p_booked_revenue_minor: metrics.bookedRevenueMinor,
    p_currency: currency,
    p_average_sales_cycle_days: metrics.averageSalesCycleDays,
    p_evidence: ev,
    p_idempotency_key: b.idempotencyKey,
  });
}

function normalizeActor(input) {
  const actorType = code(input.actorType, 'ACTOR_INVALID', 'actorType');
  const authorityTier = code(input.authorityTier, 'AUTHORITY_INVALID', 'authorityTier');
  if (actorType === 'agent' && authorityTier === 'department_head') {
    return {
      actorType,
      actorId: requiredString(input.actorId, 'ACTOR_INVALID', 'actorId', 2, 160),
      authorityTier,
    };
  }
  if (actorType === 'human' && authorityTier === 'owner') {
    return {
      actorType,
      actorId: uuid(input.actorId, 'ACTOR_INVALID', 'actorId'),
      authorityTier,
    };
  }
  if (actorType === 'system' && authorityTier === 'system'
      && (input.actorId === null || input.actorId === undefined || input.actorId === '')) {
    return { actorType, actorId: null, authorityTier };
  }
  throw new RevenueDepartmentHeadError(
    'ACTOR_AUTHORITY_INVALID',
    'actor identity does not match an allowed supervised authority',
  );
}

function planRevenueHeadWorkCommand(input) {
  const b = base(input);
  const commandName = code(input.command, 'COMMAND_INVALID', 'command');
  if (!COMMANDS.has(commandName)) {
    throw new RevenueDepartmentHeadError('COMMAND_INVALID', 'command is unsupported');
  }
  const itemId = uuid(input.itemId, 'ITEM_ID_INVALID', 'itemId');
  const reportId = uuid(input.reportId, 'REPORT_ID_INVALID', 'reportId');
  const expectedRevision = integer(
    input.expectedRevision,
    'REVISION_INVALID',
    'expectedRevision',
    0,
  );
  const actor = normalizeActor(input);
  const ev = evidence(input.evidence);
  const itemKind = input.itemKind ? code(input.itemKind, 'ITEM_KIND_INVALID', 'itemKind') : null;
  const actionScope = input.actionScope
    ? code(input.actionScope, 'ACTION_SCOPE_INVALID', 'actionScope')
    : null;
  if (commandName === 'create') {
    if (!ITEM_KINDS.has(itemKind) || !ACTION_SCOPES.has(actionScope)) {
      throw new RevenueDepartmentHeadError(
        'SUPERVISED_SCOPE_INVALID',
        'new items require an allowed kind and read-only action scope',
      );
    }
  }
  const semantics = {
    ...b,
    command: commandName,
    itemId,
    reportId,
    expectedRevision,
    actor,
    evidence: ev,
    itemKind,
    actionScope,
    title: optionalString(input.title, 'TITLE_INVALID', 'title', 3, 240),
    assigneeType: optionalString(input.assigneeType, 'ASSIGNEE_INVALID', 'assigneeType', 5, 5),
    assigneeId: optionalString(input.assigneeId, 'ASSIGNEE_INVALID', 'assigneeId', 2, 160),
    dueAt: timestamp(input.dueAt, 'DUE_AT_INVALID', 'dueAt', true),
    escalationCode: input.escalationCode
      ? code(input.escalationCode, 'ESCALATION_INVALID', 'escalationCode')
      : null,
    completionEvidenceDigest: input.completionEvidenceDigest
      ? digest(input.completionEvidenceDigest, 'COMPLETION_EVIDENCE_INVALID', 'completionEvidenceDigest')
      : null,
    decision: input.decision ? code(input.decision, 'DECISION_INVALID', 'decision') : null,
  };
  return gatedCommand('revenue_head_work_command_rpc', semantics, {
    p_tenant_id: b.tenantId,
    p_item_id: itemId,
    p_report_id: reportId,
    p_command: commandName,
    p_expected_revision: expectedRevision,
    p_actor_type: actor.actorType,
    p_actor_id: actor.actorId,
    p_authority_tier: actor.authorityTier,
    p_evidence: ev,
    p_idempotency_key: b.idempotencyKey,
    p_item_kind: semantics.itemKind,
    p_action_scope: semantics.actionScope,
    p_title: semantics.title,
    p_assignee_type: semantics.assigneeType,
    p_assignee_id: semantics.assigneeId,
    p_due_at: semantics.dueAt,
    p_escalation_code: semantics.escalationCode,
    p_completion_evidence_digest: semantics.completionEvidenceDigest,
    p_decision: semantics.decision,
  });
}

function planRevenueHeadKillSwitch(input) {
  assertNoForbiddenKeys(input);
  return Object.freeze({
    rpc: 'revenue_head_kill_switch_rpc',
    args: Object.freeze({
      p_tenant_id: uuid(input.tenantId, 'TENANT_ID_INVALID', 'tenantId'),
      p_reason: code(input.reasonCode, 'KILL_SWITCH_REASON_INVALID', 'reasonCode'),
    }),
  });
}

module.exports = {
  RevenueDepartmentHeadError,
  planRevenueCharterRegistration,
  planRevenueReportAcceptance,
  planRevenueHeadWorkCommand,
  planRevenueHeadKillSwitch,
};
