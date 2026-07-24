'use strict';

const PLATFORM_ADMIN_ROLES = new Set([
  'owner',
  'platform_owner',
  'founder',
  'admin',
]);

const TENANT_OWNER_ROLES = new Set([
  ...PLATFORM_ADMIN_ROLES,
  'client_owner',
  'tenant_owner',
]);

const DOCUMENT_CENTER_ROLES = new Set([
  ...TENANT_OWNER_ROLES,
  'manager',
  'member',
  'viewer',
]);

function normalizeRole(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function hasPlatformAdminRole(value) {
  return PLATFORM_ADMIN_ROLES.has(normalizeRole(value));
}

function hasTenantOwnerRole(value) {
  return TENANT_OWNER_ROLES.has(normalizeRole(value));
}

function hasDocumentCenterRole(value) {
  return DOCUMENT_CENTER_ROLES.has(normalizeRole(value));
}

module.exports = {
  DOCUMENT_CENTER_ROLES,
  PLATFORM_ADMIN_ROLES,
  TENANT_OWNER_ROLES,
  hasDocumentCenterRole,
  hasPlatformAdminRole,
  hasTenantOwnerRole,
  normalizeRole,
};
