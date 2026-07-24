'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const route = require('../api/routes/departments');

const {
  DATABASE_DEPARTMENT_KEYS,
  parseDepartmentQuery,
  publicContract,
  requireDepartmentRead,
} = route._internal;
const { departmentContract } = require('../core/departments/catalog');

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const USER_A = 'eeeeeeee-1111-4111-8111-111111111111';

function withDepartmentGate({ enabled, cohort = TENANT_A }, fn) {
  const flagKey = 'FGA_OS_DEPARTMENT_HEADS_ENABLED';
  const cohortKey = 'FGA_OS_DEPARTMENT_HEAD_TENANT_ALLOWLIST';
  const previousFlag = process.env[flagKey];
  const previousCohort = process.env[cohortKey];
  try {
    if (enabled === undefined) delete process.env[flagKey];
    else process.env[flagKey] = enabled;
    process.env[cohortKey] = cohort;
    return fn();
  } finally {
    if (previousFlag === undefined) delete process.env[flagKey];
    else process.env[flagKey] = previousFlag;
    if (previousCohort === undefined) delete process.env[cohortKey];
    else process.env[cohortKey] = previousCohort;
  }
}

function invokeGate({ tenantId = TENANT_A, appTenantId = TENANT_A, role = 'tenant_owner' }) {
  const result = { status: null, next: false };
  withDepartmentGate({ enabled: 'true' }, () => requireDepartmentRead({
    tenantId,
    userId: USER_A,
    user: { id: USER_A, app_metadata: { tenant_id: appTenantId, role } },
  }, {
    status(code) { result.status = code; return this; },
    json() { return this; },
  }, () => { result.next = true; }));
  return result;
}

test('department filters map only the seven canonical keys and bound limits', () => {
  assert.deepEqual(parseDepartmentQuery({ department: 'finance', limit: '500' }), {
    valid: true,
    value: {
      departmentKey: 'finance',
      databaseDepartmentKey: 'finance_data_governance',
      limit: 100,
    },
  });
  assert.equal(parseDepartmentQuery({ department: 'executive' }).valid, false);
  assert.equal(Object.keys(DATABASE_DEPARTMENT_KEYS).length, 7);
});

test('department catalog projection is tenant-bound and cannot claim write authority', () => {
  const projected = publicContract(departmentContract('product_engineering'), TENANT_A);
  assert.equal(projected.tenant_id, TENANT_A);
  assert.equal(projected.execution_mode, 'shadow');
  assert.equal(projected.production_write_authority, false);
  assert.ok(projected.owner_approval_actions.includes('deploy_production'));
  assert.ok(projected.prohibited_actions.includes('deploy_without_rollback'));
});

test('Department Head read API is hidden unless global flag and exact cohort agree', () => {
  const result = { status: null, next: false };
  const req = {
    tenantId: TENANT_A,
    userId: USER_A,
    user: { id: USER_A, app_metadata: { tenant_id: TENANT_A, role: 'tenant_owner' } },
  };
  const res = {
    status(code) { result.status = code; return this; },
    json() { return this; },
  };
  withDepartmentGate({ enabled: undefined }, () => (
    requireDepartmentRead(req, res, () => { result.next = true; })
  ));
  assert.equal(result.status, 404);
  assert.equal(result.next, false);

  withDepartmentGate({ enabled: 'true', cohort: TENANT_B }, () => (
    requireDepartmentRead(req, res, () => { result.next = true; })
  ));
  assert.equal(result.next, false);
});

test('same-tenant owner may read while role and tenant conflicts fail closed', () => {
  assert.deepEqual(invokeGate({}), { status: null, next: true });
  assert.deepEqual(invokeGate({ role: 'member' }), { status: 403, next: false });
  assert.deepEqual(
    invokeGate({ tenantId: TENANT_A, appTenantId: TENANT_B }),
    { status: 403, next: false },
  );
});

test('department routes mount below tenant auth/tripwire and expose no mutation', () => {
  const server = fs.readFileSync(
    path.join(__dirname, '..', 'api', 'server.js'),
    'utf8',
  );
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'api', 'routes', 'departments.js'),
    'utf8',
  );
  const authMount = server.indexOf("app.use('/api', authMiddleware, tenantMiddleware);");
  const tripwire = server.indexOf(
    "app.use('/api', require('./middleware/cross-tenant-tripwire'));",
  );
  const departments = server.indexOf(
    "app.use('/api/departments', require('./routes/departments'));",
  );
  assert.ok(authMount >= 0 && tripwire > authMount && departments > tripwire);
  assert.doesNotMatch(source, /router\.(post|put|patch|delete)\(/);
  assert.doesNotMatch(source, /\.select\(['"]\*['"]\)/);
  assert.doesNotMatch(source, /getServiceClient/);
});
