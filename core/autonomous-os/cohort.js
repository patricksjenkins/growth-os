'use strict';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseTenantAllowlist(value) {
  if (typeof value !== 'string') return new Set();
  return new Set(value
    .split(',')
    .map(item => item.trim().toLowerCase())
    .filter(item => UUID_RE.test(item)));
}

function tenantInCohort(tenantId, envName, env = process.env) {
  if (!UUID_RE.test(String(tenantId || ''))) return false;
  return parseTenantAllowlist(env?.[envName]).has(String(tenantId).toLowerCase());
}

module.exports = {
  parseTenantAllowlist,
  tenantInCohort,
};
