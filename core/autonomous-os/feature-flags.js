'use strict';

/**
 * Autonomous Company OS rollout controls.
 *
 * Observability is additive and defaults on. Every action or authority flag
 * defaults off so deploying code cannot silently grant a new agent permission
 * or change an active tenant workflow.
 */

function enabledUnlessFalse(name) {
  return String(process.env[name] ?? '').toLowerCase() !== 'false';
}

function enabledOnlyWhenTrue(name) {
  return String(process.env[name] ?? '').toLowerCase() === 'true';
}

const flags = {
  outcomeObservability: () => enabledUnlessFalse('FGA_OS_OUTCOME_OBSERVABILITY_ENABLED'),
  authzAppMetadataEnforce: () => enabledOnlyWhenTrue('FGA_OS_AUTHZ_APP_METADATA_ENFORCE'),
  strictWebhookVerification: () => enabledOnlyWhenTrue('FGA_OS_STRICT_WEBHOOK_VERIFICATION'),
  signedLeadCapture: () => enabledOnlyWhenTrue('FGA_OS_SIGNED_LEAD_CAPTURE_ENFORCE'),
  atomicJobClaims: () => enabledOnlyWhenTrue('FGA_OS_ATOMIC_JOB_CLAIMS_ENABLED'),
  controlPlaneApi: () => enabledOnlyWhenTrue('FGA_OS_CONTROL_PLANE_API_ENABLED'),
  decisionQueueWrites: () => enabledOnlyWhenTrue('FGA_OS_DECISION_QUEUE_WRITES_ENABLED'),
  connectedWorkflowWrites: () => enabledOnlyWhenTrue('FGA_OS_CONNECTED_WORKFLOW_WRITES_ENABLED'),
  documentCenterWrites: () => enabledOnlyWhenTrue('FGA_OS_DOCUMENT_CENTER_WRITES_ENABLED'),
  schedulingWrites: () => enabledOnlyWhenTrue('FGA_OS_SCHEDULING_WRITES_ENABLED'),
  departmentHeads: () => enabledOnlyWhenTrue('FGA_OS_DEPARTMENT_HEADS_ENABLED'),
  chiefOfStaff: () => enabledOnlyWhenTrue('FGA_OS_CHIEF_OF_STAFF_ENABLED'),
  productionAuthority: () => enabledOnlyWhenTrue('FGA_OS_PRODUCTION_AUTHORITY_ENABLED'),
};

function snapshot() {
  return Object.fromEntries(Object.entries(flags).map(([name, read]) => [name, read()]));
}

module.exports = {
  flags,
  snapshot,
  _internal: { enabledUnlessFalse, enabledOnlyWhenTrue },
};
