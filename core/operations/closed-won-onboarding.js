'use strict';

const { fingerprintRequest } = require('./work-items');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[a-f0-9]{64}$/i;
const ACTIONS = Object.freeze([
  'initiate',
  'accept',
  'acknowledge',
  'record_retry',
  'raise_exception',
  'complete',
]);
const ACTOR_TYPES = Object.freeze(['human', 'service', 'system']);
const ACTION_EVIDENCE_TYPES = Object.freeze({
  accept: 'owner_acceptance',
  acknowledge: 'onboarding_workflow',
  record_retry: 'retry_attempt',
  raise_exception: 'exception',
  complete: 'completion',
});

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function validIso(value) {
  return typeof value === 'string' && Number.isFinite(new Date(value).getTime());
}

function normalizeIso(value) {
  return validIso(value) ? new Date(value).toISOString() : null;
}

function validateActor(actor) {
  const errors = [];
  if (!actor || typeof actor !== 'object' || Array.isArray(actor)) {
    return ['actor must be an object'];
  }
  if (!ACTOR_TYPES.includes(actor.type)) errors.push('actor.type is invalid');
  if (actor.type !== 'system' && !text(actor.id)) {
    errors.push('actor.id is required for non-system actors');
  }
  if (actor.type === 'human' && !UUID_RE.test(text(actor.id))) {
    errors.push('human actor.id must be a UUID');
  }
  if (actor.type === 'system' && text(actor.id)) {
    errors.push('system actor.id must be empty');
  }
  if (text(actor.id).length > 200) errors.push('actor.id exceeds 200 characters');
  return errors;
}

/**
 * This capability has an independent caller-supplied gate. Missing, false, or
 * non-boolean gate values deny the command. The planner has no global flag
 * fallback, so a new caller cannot accidentally inherit write authority.
 */
function evaluateClosedWonOnboardingGate({ featureEnabled } = {}) {
  return {
    allowed: featureEnabled === true,
    reasons: featureEnabled === true
      ? []
      : ['closed_won_onboarding_handoff_disabled'],
  };
}

function validateEvidence(action, input, now, errors) {
  if (action === 'initiate') return null;

  const expectedType = ACTION_EVIDENCE_TYPES[action];
  const evidenceType = text(input.evidence_type).toLowerCase();
  const evidenceId = text(input.evidence_id);
  const evidenceDigest = text(input.evidence_digest).toLowerCase();
  const evidenceObservedAt = input.evidence_observed_at;

  if (evidenceType !== expectedType) {
    errors.push(`evidence_type must be ${expectedType}`);
  }
  if (!evidenceId || evidenceId.length > 240) {
    errors.push('evidence_id must be between 1 and 240 characters');
  }
  if (!SHA256_RE.test(evidenceDigest)) {
    errors.push('evidence_digest must be a SHA-256 hex digest');
  }
  if (!validIso(evidenceObservedAt)) {
    errors.push('evidence_observed_at must be an ISO date');
  } else if (validIso(now) &&
      new Date(evidenceObservedAt).getTime() > new Date(now).getTime()) {
    errors.push('evidence_observed_at cannot be in the future');
  }

  return {
    type: evidenceType,
    id: evidenceId,
    digest: evidenceDigest,
    observed_at: normalizeIso(evidenceObservedAt),
  };
}

/**
 * Build a typed request for the service-role-only database RPC.
 *
 * This is intentionally a planner, not an executor: it sends no email/SMS,
 * provisions no tenant, and does not mutate a lead. PostgreSQL re-verifies the
 * lead's `won` state and every source/client tenant relationship under locks.
 */
function planClosedWonOnboardingCommand(input = {}, {
  actor,
  featureEnabled = false,
  now = new Date().toISOString(),
} = {}) {
  const errors = [];
  const action = text(input.action).toLowerCase();
  const sourceTenantId = text(input.source_tenant_id);
  const handoffId = text(input.handoff_id) || null;
  const idempotencyKey = text(input.idempotency_key);
  const expectedRevision = input.expected_revision == null
    ? null
    : Number(input.expected_revision);

  if (!ACTIONS.includes(action)) errors.push('action is invalid');
  if (!UUID_RE.test(sourceTenantId)) {
    errors.push('source_tenant_id must be a UUID');
  }
  if (idempotencyKey.length < 8 || idempotencyKey.length > 200) {
    errors.push('idempotency_key must be between 8 and 200 characters');
  }
  if (!validIso(now)) errors.push('now must be an ISO date');
  errors.push(...validateActor(actor));
  errors.push(...evaluateClosedWonOnboardingGate({ featureEnabled }).reasons);

  let initiate = null;
  if (action === 'initiate') {
    const leadId = text(input.lead_id);
    const customerId = text(input.customer_id) || null;
    const clientTenantId = text(input.client_tenant_id);
    const onboardingWorkflowId = text(input.onboarding_workflow_id) || null;
    const sourceEventKey = text(input.source_event_key);
    const closedWonAt = input.closed_won_at;
    const acceptBy = input.accept_by;
    const acknowledgeBy = input.acknowledge_by;

    if (!UUID_RE.test(leadId)) errors.push('lead_id must be a UUID');
    if (customerId && !UUID_RE.test(customerId)) {
      errors.push('customer_id must be a UUID when provided');
    }
    if (!UUID_RE.test(clientTenantId)) {
      errors.push('client_tenant_id must be a UUID');
    }
    if (onboardingWorkflowId && !UUID_RE.test(onboardingWorkflowId)) {
      errors.push('onboarding_workflow_id must be a UUID when provided');
    }
    if (sourceEventKey.length < 8 || sourceEventKey.length > 200) {
      errors.push('source_event_key must be between 8 and 200 characters');
    }
    for (const [name, value] of [
      ['closed_won_at', closedWonAt],
      ['accept_by', acceptBy],
      ['acknowledge_by', acknowledgeBy],
    ]) {
      if (!validIso(value)) errors.push(`${name} must be an ISO date`);
    }
    if (validIso(closedWonAt) && validIso(now) &&
        new Date(closedWonAt).getTime() > new Date(now).getTime()) {
      errors.push('closed_won_at cannot be in the future');
    }
    if (validIso(closedWonAt) && validIso(acceptBy) &&
        new Date(acceptBy).getTime() <= new Date(closedWonAt).getTime()) {
      errors.push('accept_by must be after closed_won_at');
    }
    if (validIso(acceptBy) && validIso(acknowledgeBy) &&
        new Date(acknowledgeBy).getTime() < new Date(acceptBy).getTime()) {
      errors.push('acknowledge_by cannot be before accept_by');
    }

    initiate = {
      lead_id: leadId,
      customer_id: customerId,
      client_tenant_id: clientTenantId,
      onboarding_workflow_id: onboardingWorkflowId,
      source_event_key: sourceEventKey,
      closed_won_at: normalizeIso(closedWonAt),
      accept_by: normalizeIso(acceptBy),
      acknowledge_by: normalizeIso(acknowledgeBy),
    };
  } else {
    if (!UUID_RE.test(handoffId || '')) {
      errors.push('handoff_id must be a UUID for transition actions');
    }
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
      errors.push('expected_revision must be a positive integer for transition actions');
    }
  }

  const evidence = validateEvidence(action, input, now, errors);
  const onboardingWorkflowId = action === 'acknowledge'
    ? text(input.onboarding_workflow_id)
    : (initiate?.onboarding_workflow_id || null);
  if (action === 'acknowledge' && !UUID_RE.test(onboardingWorkflowId)) {
    errors.push('onboarding_workflow_id must be a UUID for acknowledgment');
  }

  const retryAt = action === 'record_retry' ? input.retry_at : null;
  const maxAttempts = action === 'record_retry'
    ? Number(input.max_attempts ?? 5)
    : 5;
  if (action === 'record_retry') {
    if (!validIso(retryAt)) {
      errors.push('retry_at must be an ISO date');
    } else if (validIso(now) &&
        new Date(retryAt).getTime() <= new Date(now).getTime()) {
      errors.push('retry_at must be in the future');
    }
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
      errors.push('max_attempts must be an integer between 1 and 20');
    }
  }

  const exceptionCode = action === 'raise_exception'
    ? text(input.exception_code).toLowerCase()
    : null;
  if (action === 'raise_exception' &&
      (!/^[a-z][a-z0-9_]{2,79}$/.test(exceptionCode))) {
    errors.push('exception_code must be a safe machine-readable identifier');
  }

  const reasonCode = text(input.reason_code).toLowerCase();
  if (action !== 'initiate' && !/^[a-z][a-z0-9_]{2,79}$/.test(reasonCode)) {
    errors.push('reason_code must be a safe machine-readable identifier');
  }

  if (errors.length) return { ok: false, errors };

  const semanticRequest = {
    operation: 'closed_won_onboarding_handoff',
    action,
    source_tenant_id: sourceTenantId,
    handoff_id: handoffId,
    expected_revision: expectedRevision,
    initiate,
    onboarding_workflow_id: onboardingWorkflowId,
    retry_at: normalizeIso(retryAt),
    max_attempts: maxAttempts,
    exception_code: exceptionCode,
    reason_code: reasonCode || null,
    evidence,
    actor: {
      type: actor.type,
      id: actor.id || null,
    },
  };
  const requestFingerprint = fingerprintRequest(semanticRequest);

  return {
    ok: true,
    request_fingerprint: requestFingerprint,
    rpc: {
      p_action: action,
      p_source_tenant_id: sourceTenantId,
      p_idempotency_key: idempotencyKey,
      p_request_fingerprint: requestFingerprint,
      p_actor_type: actor.type,
      p_actor_id: actor.id || null,
      p_handoff_id: handoffId,
      p_expected_revision: expectedRevision,
      p_lead_id: initiate?.lead_id || null,
      p_customer_id: initiate?.customer_id || null,
      p_client_tenant_id: initiate?.client_tenant_id || null,
      p_onboarding_workflow_id: onboardingWorkflowId,
      p_source_event_key: initiate?.source_event_key || null,
      p_closed_won_at: initiate?.closed_won_at || null,
      p_accept_by: initiate?.accept_by || null,
      p_acknowledge_by: initiate?.acknowledge_by || null,
      p_retry_at: normalizeIso(retryAt),
      p_max_attempts: maxAttempts,
      p_exception_code: exceptionCode,
      p_reason_code: reasonCode || null,
      p_evidence_type: evidence?.type || null,
      p_evidence_id: evidence?.id || null,
      p_evidence_digest: evidence?.digest || null,
      p_evidence_observed_at: evidence?.observed_at || null,
      p_feature_gate_enabled: true,
    },
  };
}

module.exports = {
  ACTIONS,
  ACTION_EVIDENCE_TYPES,
  evaluateClosedWonOnboardingGate,
  planClosedWonOnboardingCommand,
};
