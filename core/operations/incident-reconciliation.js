'use strict';

const {
  AUTHORITY_TIERS,
  evaluateWriteAuthority,
  fingerprintRequest,
} = require('./work-items');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERIFICATION_METHODS = Object.freeze([
  'output_observed',
  'successful_run',
]);
const EVIDENCE_REFERENCE_RE = /^[a-z][a-z0-9_-]{1,39}:[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const AUTHORITATIVE_REFERENCE_RE = Object.freeze({
  successful_run: /^agent_job:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  output_observed: /^lead:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
});

function normalizedText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function validIso(value) {
  return typeof value === 'string' && Number.isFinite(new Date(value).getTime());
}

/**
 * Incident reconciliation is independently gated in addition to the existing
 * control-plane write gates. An absent flag snapshot therefore always denies
 * the command, including in tests, local development, and future callers.
 */
function evaluateIncidentReconciliationGate({
  actor,
  requiredTier = 'system',
  flagSnapshot = {},
} = {}) {
  const base = evaluateWriteAuthority({
    actor,
    requiredTier,
    flagSnapshot,
  });
  const reasons = [...base.reasons];
  if (flagSnapshot.incidentReconciliationWrites !== true) {
    reasons.push('incident_reconciliation_writes_disabled');
  }
  return { allowed: reasons.length === 0, reasons };
}

/**
 * Build the typed RPC request for one proven recovery. This function does not
 * write or fetch data. The database RPC re-checks tenant binding, incident and
 * work-item state, authority, optimistic revision, and idempotency under lock.
 */
function planIncidentRecoveryReconciliation(input = {}, {
  actor,
  flagSnapshot = {},
  now = new Date().toISOString(),
} = {}) {
  const errors = [];
  const tenantId = normalizedText(input.tenant_id);
  const incidentId = normalizedText(input.incident_id);
  const workItemId = normalizedText(input.work_item_id);
  const idempotencyKey = normalizedText(input.idempotency_key);
  const verificationMethod = normalizedText(input.verification_method).toLowerCase();
  const verificationReference = normalizedText(input.verification_reference);
  const observedAt = input.observed_at;
  const requiredTier = normalizedText(
    input.required_authority_tier || 'system'
  ).toLowerCase();
  const expectedRevision = Number(input.expected_work_item_revision);

  if (!UUID_RE.test(tenantId)) errors.push('tenant_id must be a UUID');
  if (!UUID_RE.test(incidentId)) errors.push('incident_id must be a UUID');
  if (!UUID_RE.test(workItemId)) errors.push('work_item_id must be a UUID');
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    errors.push('expected_work_item_revision must be a positive integer');
  }
  if (idempotencyKey.length < 8 || idempotencyKey.length > 200) {
    errors.push('idempotency_key must be between 8 and 200 characters');
  }
  if (!VERIFICATION_METHODS.includes(verificationMethod)) {
    errors.push('verification_method is invalid');
  }
  if (!EVIDENCE_REFERENCE_RE.test(verificationReference)) {
    errors.push('verification_reference must be an opaque namespace:value identifier');
  } else if (
    AUTHORITATIVE_REFERENCE_RE[verificationMethod] &&
    !AUTHORITATIVE_REFERENCE_RE[verificationMethod].test(verificationReference)
  ) {
    errors.push('verification_reference does not match the authoritative evidence type');
  }
  if (!validIso(observedAt)) errors.push('observed_at must be an ISO date');
  if (!validIso(now)) errors.push('now must be an ISO date');
  if (validIso(observedAt) && validIso(now) &&
      new Date(observedAt).getTime() > new Date(now).getTime()) {
    errors.push('observed_at cannot be in the future');
  }
  if (!AUTHORITY_TIERS.includes(requiredTier)) {
    errors.push('required_authority_tier is invalid');
  }

  const gate = evaluateIncidentReconciliationGate({
    actor,
    requiredTier,
    flagSnapshot,
  });
  errors.push(...gate.reasons);
  if (errors.length) return { ok: false, errors };

  const semanticRequest = {
    operation: 'incident_recovery_reconcile',
    tenant_id: tenantId,
    incident_id: incidentId,
    work_item_id: workItemId,
    expected_work_item_revision: expectedRevision,
    verification_method: verificationMethod,
    verification_reference: verificationReference,
    observed_at: new Date(observedAt).toISOString(),
    actor: {
      type: actor.type,
      id: actor.id || null,
      authority_tier: actor.authority_tier,
    },
  };

  return {
    ok: true,
    request_fingerprint: fingerprintRequest(semanticRequest),
    rpc: {
      p_tenant_id: tenantId,
      p_incident_id: incidentId,
      p_work_item_id: workItemId,
      p_expected_work_item_revision: expectedRevision,
      p_idempotency_key: idempotencyKey,
      p_request_fingerprint: fingerprintRequest(semanticRequest),
      p_actor_type: actor.type,
      p_actor_id: actor.id || null,
      p_actor_authority_tier: actor.authority_tier,
      p_verification_method: verificationMethod,
      p_verification_reference: verificationReference,
      p_observed_at: new Date(observedAt).toISOString(),
      p_feature_gate_enabled: true,
    },
  };
}

module.exports = {
  AUTHORITATIVE_REFERENCE_RE,
  VERIFICATION_METHODS,
  evaluateIncidentReconciliationGate,
  planIncidentRecoveryReconciliation,
};
