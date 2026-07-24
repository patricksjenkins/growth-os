'use strict';

const {
  DOCUMENT_CENTER_ROLES,
  TENANT_OWNER_ROLES,
  normalizeRole,
} = require('./roles');

const CONSOLIDATED_APPROVAL_ACTIONS = new Set([
  'production.deploy',
  'production.migrate_database',
  'production.rewrite_data',
  'customer.send_email',
  'customer.send_message',
  'customer.place_call',
  'customer.send_notification',
  'content.publish_public',
  'money.charge',
  'money.refund',
  'money.transfer',
  'commercial.change_pricing',
  'commercial.change_contract',
  'legal.change_policy',
  'compliance.change_setting',
  'advertising.launch_paid',
  'mobile.release_testflight',
  'mobile.release_app_store',
  'agent.activate_department_head_writes',
  'agent.activate_chief_of_staff_writes',
]);

const ACTION_RULES = Object.freeze({
  'work_item.read': TENANT_OWNER_ROLES,
  'work_item.create': TENANT_OWNER_ROLES,
  'work_item.transition': TENANT_OWNER_ROLES,
  'document.read': DOCUMENT_CENTER_ROLES,
  'document.create_version': new Set([...TENANT_OWNER_ROLES, 'manager']),
  'document.review': new Set([...TENANT_OWNER_ROLES, 'manager']),
  'document.approve': TENANT_OWNER_ROLES,
  'document.link': new Set([...TENANT_OWNER_ROLES, 'manager']),
});

function normalizedActor(actor) {
  return {
    type: typeof actor?.type === 'string' ? actor.type.trim().toLowerCase() : '',
    id: typeof actor?.id === 'string' ? actor.id.trim() : '',
    role: normalizeRole(actor?.role),
    tenantId: typeof actor?.tenantId === 'string'
      ? actor.tenantId.trim().toLowerCase()
      : '',
  };
}

/**
 * Shared application-level authority contract.
 *
 * Database RLS and service RPC checks remain independent mandatory layers.
 * This evaluator never grants production approval and never treats an agent,
 * service, or system identity as a human tenant role.
 */
function evaluateAuthority({
  actor,
  action,
  targetTenantId,
} = {}) {
  const current = normalizedActor(actor);
  const normalizedAction = typeof action === 'string'
    ? action.trim().toLowerCase()
    : '';
  const target = typeof targetTenantId === 'string'
    ? targetTenantId.trim().toLowerCase()
    : '';
  const reasons = [];

  if (!current.type || !current.id) reasons.push('actor_identity_unverified');
  if (!target || !current.tenantId || current.tenantId !== target) {
    reasons.push('tenant_mismatch');
  }
  if (current.type !== 'human') reasons.push('human_authority_required');

  if (CONSOLIDATED_APPROVAL_ACTIONS.has(normalizedAction)) {
    reasons.push('consolidated_approval_required');
    return {
      allowed: false,
      decision: 'approval_required',
      action: normalizedAction,
      reasons: [...new Set(reasons)],
    };
  }

  const allowedRoles = ACTION_RULES[normalizedAction];
  if (!allowedRoles) reasons.push('unknown_action');
  else if (!allowedRoles.has(current.role)) reasons.push('role_not_permitted');

  return {
    allowed: reasons.length === 0,
    decision: reasons.length === 0 ? 'allow' : 'deny',
    action: normalizedAction,
    reasons: [...new Set(reasons)],
  };
}

module.exports = {
  ACTION_RULES,
  CONSOLIDATED_APPROVAL_ACTIONS,
  evaluateAuthority,
  normalizedActor,
};
