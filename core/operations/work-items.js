'use strict';

const crypto = require('node:crypto');
const { snapshot: currentAutonomousFlags } = require('../autonomous-os/feature-flags');

const KINDS = Object.freeze(['decision', 'action', 'review', 'incident', 'handoff', 'task']);
const STATUSES = Object.freeze([
  'open', 'claimed', 'in_progress', 'awaiting_verification',
  'verified', 'dismissed', 'cancelled',
]);
const PRIORITIES = Object.freeze(['critical', 'high', 'normal', 'low']);
const AUTHORITY_TIERS = Object.freeze(['system', 'department_head', 'chief_of_staff', 'owner']);
const ACTOR_TYPES = Object.freeze(['human', 'agent', 'service', 'system']);
const ASSIGNEE_TYPES = Object.freeze(['unassigned', 'human', 'agent', 'service']);
const VERIFICATION_STATES = Object.freeze(['pending', 'passed', 'failed', 'not_required']);
const TERMINAL = new Set(['verified', 'dismissed', 'cancelled']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SENSITIVE_KEY_RE = /(^|_)(api_?key|authorization|cookie|credential|password|private_?key|secret|session|token)($|_)/i;

const AUTHORITY_RANK = Object.freeze({
  system: 0,
  department_head: 1,
  chief_of_staff: 2,
  owner: 3,
});

const TRANSITIONS = Object.freeze({
  open: new Set(['claimed', 'in_progress', 'dismissed', 'cancelled']),
  claimed: new Set(['open', 'in_progress', 'dismissed', 'cancelled']),
  in_progress: new Set(['open', 'awaiting_verification', 'verified', 'cancelled']),
  awaiting_verification: new Set(['in_progress', 'verified', 'cancelled']),
  verified: new Set(['open']),
  dismissed: new Set(['open']),
  cancelled: new Set(['open']),
});

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function normalizeText(value, max) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

function validIso(value) {
  return typeof value === 'string' && Number.isFinite(new Date(value).getTime());
}

function sensitivePath(value, path = []) {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = sensitivePath(value[index], [...path, String(index)]);
      if (found) return found;
    }
    return null;
  }
  if (!isPlainObject(value)) return null;
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY_RE.test(key)) return [...path, key].join('.');
    const found = sensitivePath(child, [...path, key]);
    if (found) return found;
  }
  return null;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])])
  );
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function fingerprintRequest(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

function buildIdempotencyKey(parts) {
  const list = Array.isArray(parts) ? parts : [parts];
  const normalized = list.map((part) => String(part ?? '').trim());
  if (!normalized.length || normalized.some((part) => !part)) {
    throw new TypeError('Every idempotency-key part must be non-empty');
  }
  return `work:v1:${fingerprintRequest(normalized)}`;
}

/**
 * Compare a stored idempotency fingerprint with a requested mutation.
 * A reused key with different semantics is a conflict, never a replay.
 */
function classifyIdempotentReplay({ existingFingerprint, request } = {}) {
  if (!existingFingerprint) return { decision: 'new', fingerprint: fingerprintRequest(request) };
  const fingerprint = fingerprintRequest(request);
  return {
    decision: existingFingerprint === fingerprint ? 'replay' : 'conflict',
    fingerprint,
  };
}

function validateActor(actor) {
  const errors = [];
  if (!isPlainObject(actor)) return ['actor must be an object'];
  if (!ACTOR_TYPES.includes(actor.type)) errors.push('actor.type is invalid');
  if (!AUTHORITY_TIERS.includes(actor.authority_tier)) errors.push('actor.authority_tier is invalid');
  if (actor.type !== 'system' && !normalizeText(actor.id, 200)) {
    errors.push('actor.id is required for non-system actors');
  }
  if (actor.type === 'agent' && actor.authority_tier === 'owner') {
    errors.push('an agent cannot claim owner authority');
  }
  if (actor.type === 'service' && actor.authority_tier !== 'system') {
    errors.push('a service may exercise system authority only');
  }
  return errors;
}

/**
 * Pure authority evaluation. The caller supplies an Autonomous OS flag
 * snapshot. An absent snapshot is all-false, so no write is ever implied.
 */
function evaluateWriteAuthority({
  actor,
  requiredTier = 'system',
  productionAction = false,
  flagSnapshot = {},
} = {}) {
  const reasons = validateActor(actor);

  if (!AUTHORITY_TIERS.includes(requiredTier)) reasons.push('required authority tier is invalid');
  if (flagSnapshot.controlPlaneApi !== true) reasons.push('control_plane_api_disabled');
  if (flagSnapshot.decisionQueueWrites !== true) reasons.push('decision_queue_writes_disabled');
  if (productionAction && flagSnapshot.productionAuthority !== true) {
    reasons.push('production_authority_disabled');
  }

  if (
    AUTHORITY_TIERS.includes(requiredTier) &&
    AUTHORITY_TIERS.includes(actor?.authority_tier) &&
    AUTHORITY_RANK[actor.authority_tier] < AUTHORITY_RANK[requiredTier]
  ) {
    reasons.push('insufficient_authority_tier');
  }

  if (actor?.type === 'agent' && actor.authority_tier === 'department_head' &&
      flagSnapshot.departmentHeads !== true) {
    reasons.push('department_heads_disabled');
  }
  if (actor?.type === 'agent' && actor.authority_tier === 'chief_of_staff' &&
      flagSnapshot.chiefOfStaff !== true) {
    reasons.push('chief_of_staff_disabled');
  }

  return { allowed: reasons.length === 0, reasons };
}

function evaluateCurrentWriteAuthority(options = {}) {
  return evaluateWriteAuthority({
    ...options,
    flagSnapshot: currentAutonomousFlags(),
  });
}

function validateWorkItemInput(input) {
  const errors = [];
  if (!isPlainObject(input)) return { valid: false, errors: ['work item must be an object'] };

  const tenantId = normalizeText(input.tenant_id, 64);
  const kind = normalizeText(input.kind, 40).toLowerCase();
  const department = normalizeText(input.department, 80);
  const title = normalizeText(input.title, 240);
  const summary = input.summary == null ? null : normalizeText(input.summary, 4000);
  const priority = normalizeText(input.priority || 'normal', 20).toLowerCase();
  const authorityTier = normalizeText(input.authority_tier || 'owner', 40).toLowerCase();
  const sourceType = normalizeText(input.source_type, 80);
  const sourceId = normalizeText(input.source_id, 240);
  const idempotencyKey = normalizeText(input.idempotency_key, 200);
  const assigneeType = normalizeText(input.assignee_type || 'unassigned', 40).toLowerCase();
  const assigneeId = input.assignee_id == null ? null : normalizeText(input.assignee_id, 200);
  const dueAt = input.due_at == null ? null : input.due_at;
  const slaStartedAt = input.sla_started_at || new Date(0).toISOString();
  const actionProtocol = input.action_protocol ?? {};
  const acceptanceCriteria = input.acceptance_criteria ?? {};
  const verificationEvidence = input.verification_evidence ?? {};

  if (!UUID_RE.test(tenantId)) errors.push('tenant_id must be a UUID');
  if (!KINDS.includes(kind)) errors.push('kind is invalid');
  if (!department) errors.push('department is required');
  if (!title) errors.push('title is required');
  if (!PRIORITIES.includes(priority)) errors.push('priority is invalid');
  if (!AUTHORITY_TIERS.includes(authorityTier)) errors.push('authority_tier is invalid');
  if (!sourceType) errors.push('source_type is required');
  if (!sourceId) errors.push('source_id is required');
  if (idempotencyKey.length < 8) errors.push('idempotency_key must be at least 8 characters');
  if (!ASSIGNEE_TYPES.includes(assigneeType)) errors.push('assignee_type is invalid');
  if (assigneeType === 'unassigned' && assigneeId) errors.push('unassigned work cannot have assignee_id');
  if (assigneeType !== 'unassigned' && !assigneeId) errors.push('assigned work requires assignee_id');
  if (!isPlainObject(actionProtocol)) errors.push('action_protocol must be an object');
  if (!isPlainObject(acceptanceCriteria)) errors.push('acceptance_criteria must be an object');
  if (!isPlainObject(verificationEvidence)) errors.push('verification_evidence must be an object');
  if (input.attention_queue_id != null && !UUID_RE.test(String(input.attention_queue_id))) {
    errors.push('attention_queue_id must be a UUID when provided');
  }
  if (dueAt != null && !validIso(dueAt)) errors.push('due_at must be an ISO date when provided');
  if (input.sla_started_at != null && !validIso(input.sla_started_at)) {
    errors.push('sla_started_at must be an ISO date when provided');
  }
  if (dueAt != null && validIso(dueAt) && validIso(slaStartedAt) &&
      new Date(dueAt).getTime() < new Date(slaStartedAt).getTime()) {
    errors.push('due_at cannot be before sla_started_at');
  }

  for (const [name, value] of [
    ['action_protocol', actionProtocol],
    ['acceptance_criteria', acceptanceCriteria],
    ['verification_evidence', verificationEvidence],
  ]) {
    const path = sensitivePath(value);
    if (path) errors.push(`${name} contains forbidden sensitive key: ${path}`);
  }

  if (errors.length) return { valid: false, errors };

  return {
    valid: true,
    errors: [],
    value: {
      tenant_id: tenantId,
      schema_version: 1,
      kind,
      department,
      title,
      summary,
      status: 'open',
      priority,
      authority_tier: authorityTier,
      assignee_type: assigneeType,
      assignee_id: assigneeId,
      source_type: sourceType,
      source_id: sourceId,
      entity_type: input.entity_type == null ? null : normalizeText(input.entity_type, 80),
      entity_id: input.entity_id == null ? null : normalizeText(input.entity_id, 240),
      idempotency_key: idempotencyKey,
      attention_queue_id: input.attention_queue_id || null,
      action_protocol: stableValue(actionProtocol),
      acceptance_criteria: stableValue(acceptanceCriteria),
      verification_state: 'pending',
      verification_evidence: stableValue(verificationEvidence),
      sla_started_at: input.sla_started_at || null,
      due_at: dueAt,
    },
  };
}

function eventTypeFor(from, to) {
  if (to === 'claimed') return 'claimed';
  if (to === 'in_progress') return from === 'awaiting_verification' ? 'verification_failed' : 'started';
  if (to === 'awaiting_verification') return 'submitted_for_verification';
  if (to === 'verified') return 'verified';
  if (to === 'dismissed') return 'dismissed';
  if (to === 'cancelled') return 'cancelled';
  if (to === 'open' && TERMINAL.has(from)) return 'reopened';
  if (to === 'open') return 'released';
  return 'state_changed';
}

function planWorkItemCreate(input, {
  actor,
  flagSnapshot = {},
  now = new Date().toISOString(),
} = {}) {
  const validation = validateWorkItemInput(input);
  const gate = evaluateWriteAuthority({
    actor,
    // A low-authority producer must be able to RAISE an owner decision without
    // gaining permission to resolve it. The item's authority_tier is enforced
    // on transitions, while creation itself is a system-level ledger write.
    requiredTier: 'system',
    flagSnapshot,
  });
  const errors = [...validation.errors, ...gate.reasons];
  if (!validIso(now)) errors.push('now must be an ISO date');
  if (validation.valid && validation.value.due_at &&
      new Date(validation.value.due_at).getTime() < new Date(now).getTime()) {
    errors.push('due_at cannot be before creation time');
  }
  if (errors.length) return { ok: false, errors };

  const row = {
    ...validation.value,
    sla_started_at: validation.value.sla_started_at || now,
    created_by_type: actor.type,
    created_by_id: actor.id || null,
  };
  const requestFingerprint = fingerprintRequest({ operation: 'create', row });
  return {
    ok: true,
    row,
    event: {
      event_type: 'created',
      from_status: null,
      to_status: 'open',
      actor_type: actor.type,
      actor_id: actor.id || null,
      authority_tier: actor.authority_tier,
      reason_code: 'work_item_created',
      idempotency_key: row.idempotency_key,
      request_fingerprint: requestFingerprint,
      evidence: {},
      occurred_at: now,
    },
  };
}

function planWorkItemTransition(item, request = {}, {
  actor,
  flagSnapshot = {},
  now = new Date().toISOString(),
} = {}) {
  const errors = [];
  if (!isPlainObject(item)) return { ok: false, errors: ['work item must be an object'] };
  const from = normalizeText(item.status, 40).toLowerCase();
  const to = normalizeText(request.to_status, 40).toLowerCase();
  const reasonCode = normalizeText(request.reason_code, 120);
  const idempotencyKey = normalizeText(request.idempotency_key, 200);
  const expectedRevision = Number(request.expected_revision);
  const evidence = request.verification_evidence ?? {};
  const requestedAssigneeType = request.assignee_type == null
    ? null
    : normalizeText(request.assignee_type, 40).toLowerCase();
  const requestedAssigneeId = request.assignee_id == null
    ? null
    : normalizeText(request.assignee_id, 200);

  if (!STATUSES.includes(from)) errors.push('current status is invalid');
  if (!STATUSES.includes(to)) errors.push('target status is invalid');
  if (from === to) errors.push('target status must differ from current status');
  if (STATUSES.includes(from) && STATUSES.includes(to) && from !== to &&
      !TRANSITIONS[from].has(to)) {
    errors.push(`transition ${from} -> ${to} is not allowed`);
  }
  if (idempotencyKey.length < 8) errors.push('idempotency_key must be at least 8 characters');
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    errors.push('expected_revision must be a positive integer');
  } else if (Number(item.revision) !== expectedRevision) {
    errors.push('revision_conflict');
  }
  if (!validIso(now)) errors.push('now must be an ISO date');
  if (!isPlainObject(evidence)) errors.push('verification_evidence must be an object');
  const sensitive = sensitivePath(evidence);
  if (sensitive) errors.push(`verification_evidence contains forbidden sensitive key: ${sensitive}`);

  const reopening = to === 'open' && TERMINAL.has(from);
  if ((to === 'dismissed' || to === 'cancelled' || reopening) && !reasonCode) {
    errors.push('reason_code is required for dismiss, cancel, or reopen');
  }
  if (to === 'claimed') {
    if (!requestedAssigneeType || requestedAssigneeType === 'unassigned' ||
        !ASSIGNEE_TYPES.includes(requestedAssigneeType)) {
      errors.push('claim requires a valid assigned assignee_type');
    }
    if (!requestedAssigneeId) errors.push('claim requires assignee_id');
  }

  let verificationState = normalizeText(request.verification_state, 40).toLowerCase();
  if (to === 'verified') {
    verificationState = verificationState || item.verification_state;
    if (!['passed', 'not_required'].includes(verificationState)) {
      errors.push('verified work requires passed or not_required verification');
    }
    if (verificationState === 'passed' && Object.keys(evidence).length === 0) {
      errors.push('passed verification requires evidence');
    }
  }

  const gate = evaluateWriteAuthority({
    actor,
    requiredTier: item.authority_tier,
    productionAction: request.production_action === true,
    flagSnapshot,
  });
  errors.push(...gate.reasons);
  if (errors.length) return { ok: false, errors };

  const patch = { status: to, reason_code: reasonCode || null };
  if (to === 'claimed') {
    patch.claimed_at = now;
    patch.assignee_type = requestedAssigneeType;
    patch.assignee_id = requestedAssigneeId;
  } else if (to === 'in_progress') {
    patch.started_at = item.started_at || now;
    if (from === 'awaiting_verification') patch.verification_state = 'failed';
  } else if (to === 'awaiting_verification') {
    patch.submitted_for_verification_at = now;
    patch.verification_state = 'pending';
  } else if (to === 'verified') {
    patch.verification_state = verificationState;
    patch.verification_evidence = stableValue(evidence);
    patch.verified_at = now;
    patch.resolved_at = now;
  } else if (to === 'dismissed' || to === 'cancelled') {
    patch.resolved_at = now;
  } else if (to === 'open') {
    patch.resolved_at = null;
    patch.verified_at = null;
    patch.submitted_for_verification_at = null;
    patch.verification_state = 'pending';
    patch.verification_evidence = {};
  }

  const eventType = eventTypeFor(from, to);
  const requestBody = {
    operation: 'transition',
    tenant_id: item.tenant_id,
    work_item_id: item.id,
    from_status: from,
    to_status: to,
    expected_revision: expectedRevision,
    reason_code: reasonCode || null,
    verification_state: patch.verification_state || null,
    verification_evidence: patch.verification_evidence || {},
  };

  return {
    ok: true,
    patch,
    event: {
      event_type: eventType,
      from_status: from,
      to_status: to,
      actor_type: actor.type,
      actor_id: actor.id || null,
      authority_tier: actor.authority_tier,
      reason_code: reasonCode || null,
      idempotency_key: idempotencyKey,
      request_fingerprint: fingerprintRequest(requestBody),
      evidence: patch.verification_evidence || {},
      occurred_at: now,
    },
  };
}

module.exports = {
  KINDS,
  STATUSES,
  PRIORITIES,
  AUTHORITY_TIERS,
  ACTOR_TYPES,
  ASSIGNEE_TYPES,
  VERIFICATION_STATES,
  TRANSITIONS,
  validateWorkItemInput,
  evaluateWriteAuthority,
  evaluateCurrentWriteAuthority,
  planWorkItemCreate,
  planWorkItemTransition,
  buildIdempotencyKey,
  fingerprintRequest,
  classifyIdempotentReplay,
  _internal: {
    isPlainObject,
    sensitivePath,
    stableStringify,
    eventTypeFor,
  },
};
