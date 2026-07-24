'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  hasDocumentCenterRole,
  hasPlatformAdminRole,
  hasTenantOwnerRole,
} = require('../core/authz/roles');
const {
  parseTenantAllowlist,
  tenantInCohort,
} = require('../core/autonomous-os/cohort');

const TENANT_A = '11111111-1111-4111-8111-111111111111';

test('platform administration and tenant ownership are separate role contracts', () => {
  assert.equal(hasPlatformAdminRole('owner'), true);
  assert.equal(hasPlatformAdminRole('platform_owner'), true);
  assert.equal(hasPlatformAdminRole('client_owner'), false);
  assert.equal(hasTenantOwnerRole('client_owner'), true);
  assert.equal(hasTenantOwnerRole('tenant_owner'), true);
  assert.equal(hasTenantOwnerRole('member'), false);
});

test('Document Center roles include read-only tenant members but reject unknown claims', () => {
  for (const role of ['client_owner', 'tenant_owner', 'manager', 'member', 'viewer']) {
    assert.equal(hasDocumentCenterRole(role), true);
  }
  assert.equal(hasDocumentCenterRole('agent'), false);
  assert.equal(hasDocumentCenterRole(''), false);
});

test('feature cohorts are explicit UUID allowlists and default closed', () => {
  assert.deepEqual([...parseTenantAllowlist('bad,')], []);
  assert.equal(tenantInCohort(TENANT_A, 'TEST_COHORT', {}), false);
  assert.equal(tenantInCohort(TENANT_A, 'TEST_COHORT', {
    TEST_COHORT: `bad, ${TENANT_A}`,
  }), true);
});
