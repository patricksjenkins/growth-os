'use strict';

const crypto = require('node:crypto');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CODE = /^[a-z][a-z0-9_]{1,63}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,239}$/;
const SHA = /^[a-f0-9]{64}$/;
const COMMANDS = new Set(['create', 'accept', 'start', 'escalate', 'complete', 'record_decision']);
const KINDS = new Set(['goal', 'work', 'decision', 'exception']);
const SCOPES = new Set([
  'analyze_client_health',
  'track_client_goal',
  'recommend_intervention',
  'request_owner_decision',
  'raise_client_exception',
  'verify_support_evidence',
]);
const FORBIDDEN = new Set([
  'email', 'phone', 'recipient', 'message', 'body', 'reply', 'send',
  'dispatch', 'provider', 'providerpayload', 'providertoken', 'rawticket',
  'ticketbody', 'customername', 'customeremail', 'customerphone',
  'charge', 'refund', 'credit', 'payment',
]);

class ClientSuccessHeadError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ClientSuccessHeadError';
    this.code = code;
  }
}

function required(value, code, label, min = 1, max = 240) {
  if (typeof value !== 'string') throw new ClientSuccessHeadError(code, `${label} must be a string`);
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) {
    throw new ClientSuccessHeadError(code, `${label} has an invalid length`);
  }
  return normalized;
}

function optional(value, code, label, min = 1, max = 240) {
  if (value === null || value === undefined || value === '') return null;
  return required(value, code, label, min, max);
}

function uuid(value, code, label, allowNull = false) {
  if (allowNull && (value === null || value === undefined || value === '')) return null;
  const normalized = required(value, code, label, 36, 36).toLowerCase();
  if (!UUID.test(normalized)) throw new ClientSuccessHeadError(code, `${label} must be a UUID`);
  return normalized;
}

function code(value, errorCode, label) {
  const normalized = required(value, errorCode, label, 2, 64).toLowerCase();
  if (!CODE.test(normalized)) throw new ClientSuccessHeadError(errorCode, `${label} must be a code`);
  return normalized;
}

function ref(value, errorCode, label) {
  const normalized = required(value, errorCode, label, 2, 240);
  if (!REF.test(normalized) || normalized.includes('@')) {
    throw new ClientSuccessHeadError(errorCode, `${label} must be an opaque reference`);
  }
  return normalized;
}

function digest(value, errorCode, label) {
  const normalized = required(value, errorCode, label, 64, 64).toLowerCase();
  if (!SHA.test(normalized)) throw new ClientSuccessHeadError(errorCode, `${label} must be a digest`);
  return normalized;
}

function timestamp(value, errorCode, label, allowNull = false) {
  if (allowNull && (value === null || value === undefined || value === '')) return null;
  const parsed = Date.parse(required(value, errorCode, label, 20, 40));
  if (!Number.isFinite(parsed)) throw new ClientSuccessHeadError(errorCode, `${label} must be ISO time`);
  return new Date(parsed).toISOString();
}

function date(value, errorCode, label) {
  const normalized = required(value, errorCode, label, 10, 10);
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)
      || Number.isNaN(parsed.getTime())
      || parsed.toISOString().slice(0, 10) !== normalized) {
    throw new ClientSuccessHeadError(errorCode, `${label} must be an ISO date`);
  }
  return normalized;
}

function integer(value, errorCode, label, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ClientSuccessHeadError(errorCode, `${label} must be a safe integer`);
  }
  return value;
}

function decimal(value, errorCode, label, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new ClientSuccessHeadError(errorCode, `${label} is outside its allowed range`);
  }
  return value;
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(stable(value)).digest('hex');
}

function rejectForbidden(value, path = 'command') {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectForbidden(item, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (FORBIDDEN.has(normalizedKey)) {
      throw new ClientSuccessHeadError(
        'PROHIBITED_ACTION_INPUT',
        `${path}.${key} exceeds supervised read-only authority`,
      );
    }
    rejectForbidden(child, `${path}.${key}`);
  }
}

function evidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ClientSuccessHeadError('EVIDENCE_REQUIRED', 'evidence must be an object');
  }
  rejectForbidden(value, 'evidence');
  if (value.schema_version !== 1 || !Array.isArray(value.sources)
      || value.sources.length < 1 || value.sources.length > 50) {
    throw new ClientSuccessHeadError('EVIDENCE_INVALID', 'evidence requires 1-50 sources');
  }
  if (Object.keys(value).sort().join(',') !== 'schema_version,sources') {
    throw new ClientSuccessHeadError('EVIDENCE_INVALID', 'evidence contains unsupported fields');
  }
  const sourceFields = 'evidence_digest,observed_at,source_id,source_type';
  const sources = value.sources.map(source => {
    if (!source || typeof source !== 'object' || Array.isArray(source)
        || Object.keys(source).sort().join(',') !== sourceFields) {
      throw new ClientSuccessHeadError(
        'EVIDENCE_SOURCE_INVALID',
        'evidence source contains unsupported fields',
      );
    }
    return {
      source_type: code(source.source_type, 'EVIDENCE_SOURCE_INVALID', 'source_type'),
      source_id: ref(source.source_id, 'EVIDENCE_SOURCE_INVALID', 'source_id'),
      evidence_digest: digest(source.evidence_digest, 'EVIDENCE_SOURCE_INVALID', 'evidence_digest'),
      observed_at: timestamp(source.observed_at, 'EVIDENCE_SOURCE_INVALID', 'observed_at'),
    };
  });
  const identities = new Set(sources.map(source => `${source.source_type}:${source.source_id}`));
  if (identities.size !== sources.length) {
    throw new ClientSuccessHeadError('EVIDENCE_DUPLICATE', 'evidence source identities must be unique');
  }
  return { schema_version: 1, sources };
}

function base(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ClientSuccessHeadError('COMMAND_REQUIRED', 'command input is required');
  }
  rejectForbidden(input);
  return {
    tenantId: uuid(input.tenantId, 'TENANT_ID_INVALID', 'tenantId'),
    idempotencyKey: required(input.idempotencyKey, 'IDEMPOTENCY_INVALID', 'idempotencyKey', 8, 200),
  };
}

function gated(rpc, semantics, args) {
  return Object.freeze({
    rpc,
    args: Object.freeze({
      ...args,
      p_request_fingerprint: fingerprint(semantics),
      p_feature_gate_enabled: false,
    }),
  });
}

function planClientSuccessCharter(input) {
  const b = base(input);
  const actorId = uuid(input.actorId, 'ACTOR_INVALID', 'actorId');
  const version = integer(input.version, 'VERSION_INVALID', 'version', 1, 1000000);
  const mission = required(input.mission, 'MISSION_INVALID', 'mission', 40, 1000);
  const kpis = {
    maxFirstResponseMinutes: integer(input.kpis?.maxFirstResponseMinutes, 'KPI_INVALID', 'maxFirstResponseMinutes', 1, 100000),
    maxResolutionMinutes: integer(input.kpis?.maxResolutionMinutes, 'KPI_INVALID', 'maxResolutionMinutes', 1, 10000000),
    maxSlaBreachRateBps: integer(input.kpis?.maxSlaBreachRateBps, 'KPI_INVALID', 'maxSlaBreachRateBps', 0, 10000),
    minCsatBps: integer(input.kpis?.minCsatBps, 'KPI_INVALID', 'minCsatBps', 1, 10000),
    maxOpenCriticalTickets: integer(input.kpis?.maxOpenCriticalTickets, 'KPI_INVALID', 'maxOpenCriticalTickets', 0, 1000000),
  };
  const ev = evidence(input.evidence);
  const semantics = { ...b, actorId, version, mission, kpis, evidence: ev };
  return gated('client_success_head_charter_register_rpc', semantics, {
    p_tenant_id: b.tenantId,
    p_version: version,
    p_mission: mission,
    p_max_first_response_minutes: kpis.maxFirstResponseMinutes,
    p_max_resolution_minutes: kpis.maxResolutionMinutes,
    p_max_sla_breach_rate_bps: kpis.maxSlaBreachRateBps,
    p_min_csat_bps: kpis.minCsatBps,
    p_max_open_critical_tickets: kpis.maxOpenCriticalTickets,
    p_actor_id: actorId,
    p_evidence: ev,
    p_idempotency_key: b.idempotencyKey,
  });
}

function planClientSuccessReport(input) {
  const b = base(input);
  if (input.supportSourceId !== undefined
      || input.supportEvidenceDigest !== undefined
      || input.supportObservedAt !== undefined
      || input.metrics !== undefined) {
    throw new ClientSuccessHeadError(
      'CALLER_SUPPORT_EVIDENCE_FORBIDDEN',
      'report support health must come from a canonical support snapshot',
    );
  }
  const charterId = uuid(input.charterId, 'CHARTER_INVALID', 'charterId');
  const reportId = uuid(input.reportId, 'REPORT_INVALID', 'reportId');
  const customerId = uuid(input.customerId, 'CUSTOMER_INVALID', 'customerId');
  const healthSnapshotId = uuid(input.healthSnapshotId, 'HEALTH_SNAPSHOT_INVALID', 'healthSnapshotId');
  const interventionId = uuid(input.interventionId, 'INTERVENTION_INVALID', 'interventionId', true);
  const supportSnapshotId = uuid(
    input.supportSnapshotId,
    'SUPPORT_SNAPSHOT_INVALID',
    'supportSnapshotId',
  );
  const actorId = required(input.actorId, 'ACTOR_INVALID', 'actorId', 2, 160);
  const periodStart = date(input.periodStart, 'PERIOD_INVALID', 'periodStart');
  const periodEnd = date(input.periodEnd, 'PERIOD_INVALID', 'periodEnd');
  if (periodEnd < periodStart) throw new ClientSuccessHeadError('PERIOD_INVALID', 'period order invalid');
  const ev = evidence(input.evidence);
  const semantics = {
    ...b, charterId, reportId, customerId, healthSnapshotId, interventionId,
    supportSnapshotId, actorId, authorityTier: 'department_head',
    periodStart, periodEnd, evidence: ev,
  };
  return gated('client_success_head_report_accept_rpc', semantics, {
    p_tenant_id: b.tenantId,
    p_report_id: reportId,
    p_charter_id: charterId,
    p_customer_id: customerId,
    p_health_snapshot_id: healthSnapshotId,
    p_intervention_id: interventionId,
    p_support_snapshot_id: supportSnapshotId,
    p_period_start: periodStart,
    p_period_end: periodEnd,
    p_actor_id: actorId,
    p_authority_tier: 'department_head',
    p_evidence: ev,
    p_idempotency_key: b.idempotencyKey,
  });
}

function planClientSuccessSupportSnapshot(input) {
  const b = base(input);
  const snapshotId = uuid(input.snapshotId, 'SUPPORT_SNAPSHOT_INVALID', 'snapshotId');
  const customerId = uuid(input.customerId, 'CUSTOMER_INVALID', 'customerId');
  const sourceSnapshotId = ref(
    input.sourceSnapshotId,
    'SUPPORT_SOURCE_INVALID',
    'sourceSnapshotId',
  );
  const evidenceDigest = digest(
    input.evidenceDigest,
    'SUPPORT_EVIDENCE_INVALID',
    'evidenceDigest',
  );
  const observedAt = timestamp(
    input.observedAt,
    'SUPPORT_EVIDENCE_INVALID',
    'observedAt',
  );
  const verificationState = code(
    input.verificationState,
    'SUPPORT_VERIFICATION_INVALID',
    'verificationState',
  );
  if (!['verified', 'unverified'].includes(verificationState)) {
    throw new ClientSuccessHeadError(
      'SUPPORT_VERIFICATION_INVALID',
      'verificationState is unsupported',
    );
  }
  const actorId = required(input.actorId, 'ACTOR_INVALID', 'actorId', 2, 160);
  const metrics = {
    openedTickets: integer(input.metrics?.openedTickets, 'SUPPORT_METRIC_INVALID', 'openedTickets'),
    resolvedTickets: integer(input.metrics?.resolvedTickets, 'SUPPORT_METRIC_INVALID', 'resolvedTickets'),
    slaBreachedTickets: integer(input.metrics?.slaBreachedTickets, 'SUPPORT_METRIC_INVALID', 'slaBreachedTickets'),
    openCriticalTickets: integer(input.metrics?.openCriticalTickets, 'SUPPORT_METRIC_INVALID', 'openCriticalTickets'),
    firstResponseMinutes: decimal(input.metrics?.firstResponseMinutes, 'SUPPORT_METRIC_INVALID', 'firstResponseMinutes', 0, 100000),
    resolutionMinutes: decimal(input.metrics?.resolutionMinutes, 'SUPPORT_METRIC_INVALID', 'resolutionMinutes', 0, 10000000),
    csatBps: integer(input.metrics?.csatBps, 'SUPPORT_METRIC_INVALID', 'csatBps', 0, 10000),
  };
  if (metrics.resolvedTickets > metrics.openedTickets
      || metrics.slaBreachedTickets > metrics.openedTickets) {
    throw new ClientSuccessHeadError('SUPPORT_METRIC_INVALID', 'support counts are inconsistent');
  }
  const semantics = {
    ...b, snapshotId, customerId, sourceSnapshotId, evidenceDigest, observedAt,
    verificationState, metrics, actorId, authorityTier: 'support_evidence_adapter',
  };
  return gated('client_success_support_snapshot_record_rpc', semantics, {
    p_tenant_id: b.tenantId,
    p_snapshot_id: snapshotId,
    p_customer_id: customerId,
    p_source_snapshot_id: sourceSnapshotId,
    p_evidence_digest: evidenceDigest,
    p_observed_at: observedAt,
    p_verification_state: verificationState,
    p_opened_tickets: metrics.openedTickets,
    p_resolved_tickets: metrics.resolvedTickets,
    p_sla_breached_tickets: metrics.slaBreachedTickets,
    p_open_critical_tickets: metrics.openCriticalTickets,
    p_first_response_minutes: metrics.firstResponseMinutes,
    p_resolution_minutes: metrics.resolutionMinutes,
    p_csat_bps: metrics.csatBps,
    p_actor_id: actorId,
    p_authority_tier: 'support_evidence_adapter',
    p_idempotency_key: b.idempotencyKey,
  });
}

function actor(input) {
  const actorType = code(input.actorType, 'ACTOR_INVALID', 'actorType');
  const authorityTier = code(input.authorityTier, 'AUTHORITY_INVALID', 'authorityTier');
  if (actorType === 'agent' && authorityTier === 'department_head') {
    return { actorType, actorId: required(input.actorId, 'ACTOR_INVALID', 'actorId', 2, 160), authorityTier };
  }
  if (actorType === 'human' && authorityTier === 'owner') {
    return { actorType, actorId: uuid(input.actorId, 'ACTOR_INVALID', 'actorId'), authorityTier };
  }
  if (actorType === 'system' && authorityTier === 'system'
      && (input.actorId === null || input.actorId === undefined || input.actorId === '')) {
    return { actorType, actorId: null, authorityTier };
  }
  throw new ClientSuccessHeadError('ACTOR_AUTHORITY_INVALID', 'actor authority is unsupported');
}

function planClientSuccessWork(input) {
  const b = base(input);
  const command = code(input.command, 'COMMAND_INVALID', 'command');
  if (!COMMANDS.has(command)) throw new ClientSuccessHeadError('COMMAND_INVALID', 'command unsupported');
  const itemId = uuid(input.itemId, 'ITEM_INVALID', 'itemId');
  const reportId = uuid(input.reportId, 'REPORT_INVALID', 'reportId');
  const expectedRevision = integer(input.expectedRevision, 'REVISION_INVALID', 'expectedRevision');
  const who = actor(input);
  const ev = evidence(input.evidence);
  const kind = input.itemKind ? code(input.itemKind, 'KIND_INVALID', 'itemKind') : null;
  const scope = input.actionScope ? code(input.actionScope, 'SCOPE_INVALID', 'actionScope') : null;
  if (command === 'create' && (!KINDS.has(kind) || !SCOPES.has(scope))) {
    throw new ClientSuccessHeadError('SUPERVISED_SCOPE_INVALID', 'item scope is not read-only');
  }
  const semantics = {
    ...b, command, itemId, reportId, expectedRevision, actor: who, evidence: ev,
    itemKind: kind, actionScope: scope,
    title: optional(input.title, 'TITLE_INVALID', 'title', 3, 240),
    assigneeType: optional(input.assigneeType, 'ASSIGNEE_INVALID', 'assigneeType', 5, 5),
    assigneeId: optional(input.assigneeId, 'ASSIGNEE_INVALID', 'assigneeId', 2, 160),
    dueAt: timestamp(input.dueAt, 'DUE_INVALID', 'dueAt', true),
    escalationCode: input.escalationCode ? code(input.escalationCode, 'ESCALATION_INVALID', 'escalationCode') : null,
    completionEvidenceDigest: input.completionEvidenceDigest
      ? digest(input.completionEvidenceDigest, 'COMPLETION_INVALID', 'completionEvidenceDigest')
      : null,
    decision: input.decision ? code(input.decision, 'DECISION_INVALID', 'decision') : null,
  };
  return gated('client_success_head_work_command_rpc', semantics, {
    p_tenant_id: b.tenantId,
    p_item_id: itemId,
    p_report_id: reportId,
    p_command: command,
    p_expected_revision: expectedRevision,
    p_actor_type: who.actorType,
    p_actor_id: who.actorId,
    p_authority_tier: who.authorityTier,
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

function planClientSuccessKillSwitch(input) {
  rejectForbidden(input);
  return Object.freeze({
    rpc: 'client_success_head_kill_switch_rpc',
    args: Object.freeze({
      p_tenant_id: uuid(input.tenantId, 'TENANT_ID_INVALID', 'tenantId'),
      p_reason: code(input.reasonCode, 'REASON_INVALID', 'reasonCode'),
    }),
  });
}

module.exports = {
  ClientSuccessHeadError,
  planClientSuccessCharter,
  planClientSuccessSupportSnapshot,
  planClientSuccessReport,
  planClientSuccessWork,
  planClientSuccessKillSwitch,
};
