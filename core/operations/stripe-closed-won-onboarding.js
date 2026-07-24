'use strict';

const crypto = require('node:crypto');
const { flags } = require('../autonomous-os/feature-flags');
const { tenantInCohort } = require('../autonomous-os/cohort');
const {
  planClosedWonOnboardingCommand,
} = require('./closed-won-onboarding');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACCEPT_AFTER_MS = 2 * 60 * 60 * 1000;
const ACKNOWLEDGE_AFTER_MS = 4 * 60 * 60 * 1000;

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function uuid(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return UUID_RE.test(normalized) ? normalized : null;
}

function stripeEventTime(session) {
  const seconds = Number(session?.created);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const value = new Date(seconds * 1000);
  return Number.isFinite(value.getTime()) ? value.toISOString() : null;
}

function evaluateRuntimeGate({
  sourceTenantId,
  clientTenantId,
  flagSnapshot = {
    connectedWorkflowWrites: flags.connectedWorkflowWrites(),
    closedWonOnboardingWrites: flags.closedWonOnboardingWrites(),
    strictWebhookVerification: flags.strictWebhookVerification(),
  },
  env = process.env,
} = {}) {
  const reasons = [];
  if (flagSnapshot.connectedWorkflowWrites !== true) {
    reasons.push('connected_workflow_writes_disabled');
  }
  if (flagSnapshot.closedWonOnboardingWrites !== true) {
    reasons.push('closed_won_onboarding_writes_disabled');
  }
  if (flagSnapshot.strictWebhookVerification !== true) {
    reasons.push('strict_webhook_verification_disabled');
  }
  if (!tenantInCohort(
    sourceTenantId,
    'FGA_OS_CLOSED_WON_SOURCE_TENANT_ALLOWLIST',
    env
  )) {
    reasons.push('source_tenant_not_allowlisted');
  }
  if (!tenantInCohort(
    clientTenantId,
    'FGA_OS_CLOSED_WON_CLIENT_TENANT_ALLOWLIST',
    env
  )) {
    reasons.push('client_tenant_not_allowlisted');
  }
  return { allowed: reasons.length === 0, reasons };
}

function normalizeStripeHandoff({ session, workflow } = {}) {
  const metadata = session?.metadata || {};
  const sourceTenantId = uuid(metadata.source_tenant_id);
  const clientTenantId = uuid(metadata.tenant_id);
  const leadId = uuid(metadata.lead_id);
  const customerId = metadata.source_customer_id
    ? uuid(metadata.source_customer_id)
    : null;
  const workflowId = uuid(workflow?.id);
  const closedWonAt = stripeEventTime(session);
  const errors = [];

  if (!sourceTenantId) errors.push('source_tenant_id_missing_or_invalid');
  if (!clientTenantId) errors.push('client_tenant_id_missing_or_invalid');
  if (!leadId) errors.push('lead_id_missing_or_invalid');
  if (metadata.source_customer_id && !customerId) {
    errors.push('source_customer_id_invalid');
  }
  if (!workflowId) errors.push('onboarding_workflow_id_missing_or_invalid');
  if (workflow?.tenant_id !== clientTenantId) {
    errors.push('onboarding_workflow_tenant_mismatch');
  }
  if (!closedWonAt) errors.push('stripe_event_time_missing_or_invalid');
  if (!session?.id || String(session.id).length > 240) {
    errors.push('stripe_session_id_missing_or_invalid');
  }
  if (session?.status && session.status !== 'complete') {
    errors.push('stripe_checkout_not_complete');
  }
  if (
    session?.payment_status
    && !['paid', 'no_payment_required'].includes(session.payment_status)
  ) {
    errors.push('stripe_payment_not_authoritative');
  }
  if (errors.length) return { ok: false, errors };

  const eventRef = digest(session.id);
  const evidence = {
    provider: 'stripe',
    event_kind: 'checkout.session.completed',
    event_ref: eventRef,
    source_tenant_id: sourceTenantId,
    client_tenant_id: clientTenantId,
    lead_id: leadId,
    customer_id: customerId,
    onboarding_workflow_id: workflowId,
    checkout_status: session.status || 'complete',
    payment_status: session.payment_status || 'unknown',
    closed_won_at: closedWonAt,
  };
  const evidenceDigest = digest(JSON.stringify(evidence));
  const closed = new Date(closedWonAt).getTime();

  return {
    ok: true,
    handoff: {
      source_tenant_id: sourceTenantId,
      client_tenant_id: clientTenantId,
      lead_id: leadId,
      customer_id: customerId,
      onboarding_workflow_id: workflowId,
      source_event_key: `stripe-checkout:${eventRef}`,
      closed_won_at: closedWonAt,
      accept_by: new Date(closed + ACCEPT_AFTER_MS).toISOString(),
      acknowledge_by: new Date(closed + ACKNOWLEDGE_AFTER_MS).toISOString(),
      evidence_id: `stripe_checkout:${eventRef}`,
      evidence_digest: evidenceDigest,
    },
  };
}

function validateRpcResult(data, expected) {
  const handoff = data?.handoff;
  const event = data?.event;
  if (
    !['created', 'applied', 'replay'].includes(data?.outcome)
    || !handoff?.id
    || handoff.source_tenant_id !== expected.source_tenant_id
    || handoff.client_tenant_id !== expected.client_tenant_id
    || handoff.lead_id !== expected.lead_id
    || handoff.onboarding_workflow_id !== expected.onboarding_workflow_id
    || !Number.isInteger(Number(handoff.revision))
    || !event?.id
    || event.handoff_id !== handoff.id
    || event.source_tenant_id !== expected.source_tenant_id
  ) {
    const error = new Error('closed_won_onboarding_rpc_result_invalid');
    error.code = 'CLOSED_WON_ONBOARDING_RESULT_INVALID';
    throw error;
  }
  return data;
}

async function executePlan(client, plan, expected) {
  if (!plan.ok) {
    const error = new Error('closed_won_onboarding_command_invalid');
    error.code = 'CLOSED_WON_ONBOARDING_COMMAND_INVALID';
    error.reasons = plan.errors;
    throw error;
  }
  const { data, error } = await client.rpc(
    'closed_won_onboarding_handoff_rpc',
    plan.rpc
  );
  if (error) throw error;
  return validateRpcResult(data, expected);
}

async function projectStripeClosedWonOnboarding({
  client,
  session,
  workflow,
  now = new Date().toISOString(),
  gate,
} = {}) {
  const normalized = normalizeStripeHandoff({ session, workflow });
  if (!normalized.ok) {
    return { mode: 'disabled', reasons: normalized.errors };
  }
  const handoff = normalized.handoff;
  const runtimeGate = gate || evaluateRuntimeGate({
    sourceTenantId: handoff.source_tenant_id,
    clientTenantId: handoff.client_tenant_id,
  });
  if (!runtimeGate.allowed) {
    return { mode: 'disabled', reasons: runtimeGate.reasons };
  }

  const serviceActor = { type: 'service', id: 'stripe-onboarding-handoff' };
  const baseKey = digest(
    `${handoff.source_tenant_id}:${handoff.source_event_key}`
  );
  let result = await executePlan(client, planClosedWonOnboardingCommand({
    action: 'initiate',
    ...handoff,
    idempotency_key: `closed-won:initiate:${baseKey}`,
  }, {
    actor: serviceActor,
    featureEnabled: true,
    now,
  }), handoff);

  if (result.handoff.state === 'pending_acceptance') {
    result = await executePlan(client, planClosedWonOnboardingCommand({
      action: 'accept',
      source_tenant_id: handoff.source_tenant_id,
      handoff_id: result.handoff.id,
      expected_revision: Number(result.handoff.revision),
      idempotency_key: `closed-won:accept:${baseKey}`,
      reason_code: 'stripe_checkout_accepted',
      evidence_type: 'service_acceptance',
      evidence_id: handoff.evidence_id,
      evidence_digest: handoff.evidence_digest,
      evidence_observed_at: now,
    }, {
      actor: serviceActor,
      featureEnabled: true,
      now,
    }), handoff);
  }

  if (result.handoff.state === 'accepted') {
    result = await executePlan(client, planClosedWonOnboardingCommand({
      action: 'acknowledge',
      source_tenant_id: handoff.source_tenant_id,
      handoff_id: result.handoff.id,
      expected_revision: Number(result.handoff.revision),
      onboarding_workflow_id: handoff.onboarding_workflow_id,
      idempotency_key: `closed-won:acknowledge:${baseKey}`,
      reason_code: 'onboarding_workflow_created',
      evidence_type: 'onboarding_workflow',
      evidence_id: `onboarding_workflow:${handoff.onboarding_workflow_id}`,
      evidence_digest: handoff.evidence_digest,
      evidence_observed_at: now,
    }, {
      actor: serviceActor,
      featureEnabled: true,
      now,
    }), handoff);
  }

  if (!['acknowledged', 'completed'].includes(result.handoff.state)) {
    const error = new Error('closed_won_onboarding_not_acknowledged');
    error.code = 'CLOSED_WON_ONBOARDING_NOT_ACKNOWLEDGED';
    throw error;
  }

  return {
    mode: 'canonical',
    outcome: result.data?.outcome || result.outcome,
    handoff_id: result.handoff.id,
    state: result.handoff.state,
  };
}

module.exports = {
  evaluateRuntimeGate,
  normalizeStripeHandoff,
  projectStripeClosedWonOnboarding,
  _internal: {
    digest,
    executePlan,
    stripeEventTime,
    validateRpcResult,
  },
};
