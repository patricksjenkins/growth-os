'use strict';

const { TENANT_OWNER_ROLES } = require('../authz/roles');

const OWNER_ROLES = TENANT_OWNER_ROLES;
const MANAGER_PERMISSIONS = new Set(['read', 'create_version', 'review', 'link']);
const MEMBER_READ_CLASSIFICATIONS = new Set(['public', 'client']);
const PERMISSIONS = new Set([
  'read',
  'create_version',
  'review',
  'approve',
  'publish',
  'retire',
  'link',
  'manage',
]);

function text(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function matchingGrant(grant, actor, documentId, now) {
  if (!grant || grant.document_id !== documentId || grant.revoked_at) return false;
  if (grant.expires_at && new Date(grant.expires_at).getTime() <= now.getTime()) return false;
  const type = text(grant.principal_type);
  const id = text(grant.principal_id);
  if (type === 'role') return id === text(actor.role);
  if (type === 'user') return actor.type === 'user' && id === text(actor.id);
  if (type === 'agent') return actor.type === 'agent' && id === text(actor.id);
  return false;
}

function evaluateDocumentAccess({
  actor,
  document,
  grants = [],
  permission = 'read',
  now = new Date(),
} = {}) {
  const reasons = [];
  const requested = text(permission);
  if (!PERMISSIONS.has(requested)) reasons.push('invalid_permission');
  if (!actor?.tenantId || !document?.tenant_id || actor.tenantId !== document.tenant_id) {
    reasons.push('tenant_mismatch');
  }
  if (document?.deleted_at) reasons.push('document_deleted');
  if (reasons.length) return { allowed: false, source: 'deny', reasons };

  const role = text(actor.role);
  if (actor.type === 'user' && OWNER_ROLES.has(role)) {
    return { allowed: true, source: 'owner_role', reasons: [] };
  }

  const applicable = grants.filter(grant =>
    matchingGrant(grant, actor, document.id, now));
  const granted = applicable.some(grant => {
    const permissions = Array.isArray(grant.permissions)
      ? grant.permissions.map(text)
      : [];
    return permissions.includes('manage') || permissions.includes(requested);
  });
  if (granted) return { allowed: true, source: 'explicit_grant', reasons: [] };

  if (
    actor.type === 'user' &&
    role === 'manager' &&
    MANAGER_PERMISSIONS.has(requested) &&
    document.classification !== 'restricted'
  ) {
    return { allowed: true, source: 'manager_role', reasons: [] };
  }

  if (
    actor.type === 'user' &&
    requested === 'read' &&
    MEMBER_READ_CLASSIFICATIONS.has(document.classification)
  ) {
    return { allowed: true, source: 'classification', reasons: [] };
  }

  return { allowed: false, source: 'deny', reasons: ['permission_not_granted'] };
}

module.exports = {
  MANAGER_PERMISSIONS,
  MEMBER_READ_CLASSIFICATIONS,
  OWNER_ROLES,
  PERMISSIONS,
  evaluateDocumentAccess,
};
