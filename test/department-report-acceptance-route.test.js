'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const route = require('../api/routes/department-report-acceptance');

const { requireContractAcceptance } = route._internal;
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const USER_A = 'eeeeeeee-1111-4111-8111-111111111111';

function withGates(fn) {
  const keys = {
    FGA_OS_DEPARTMENT_HEADS_ENABLED: 'true',
    FGA_OS_DEPARTMENT_HEAD_WRITES_ENABLED: 'true',
    FGA_OS_DEPARTMENT_HEAD_TENANT_ALLOWLIST: TENANT_A,
    FGA_OS_DEPARTMENT_HEAD_WRITE_TENANT_ALLOWLIST: TENANT_A,
  };
  const previous = Object.fromEntries(Object.keys(keys).map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, keys);
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function invoke({ tenantId = TENANT_A, appTenantId = TENANT_A, role = 'tenant_owner' } = {}) {
  const result = { status: null, next: false };
  withGates(() => requireContractAcceptance({
    tenantId,
    userId: USER_A,
    user: { id: USER_A, app_metadata: { tenant_id: appTenantId, role } },
  }, {
    status(code) { result.status = code; return this; },
    json() { return this; },
  }, () => { result.next = true; }));
  return result;
}

test('only the exact-tenant human owner reaches report contract acceptance', () => {
  assert.deepEqual(invoke(), { status: null, next: true });
  assert.deepEqual(invoke({ role: 'member' }), { status: 403, next: false });
  assert.deepEqual(invoke({ appTenantId: TENANT_B }), { status: 403, next: false });
  assert.deepEqual(invoke({ tenantId: TENANT_B }), { status: 404, next: false });
});

test('acceptance is isolated from provider and production-authority actions', () => {
  const server = fs.readFileSync(
    path.join(__dirname, '..', 'api', 'server.js'),
    'utf8',
  );
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'api', 'routes', 'department-report-acceptance.js'),
    'utf8',
  );
  assert.match(source, /accept_report_contract/);
  assert.match(source, /accept_contract/);
  assert.match(source, /activate_chief_of_staff_shadow/);
  assert.match(source, /cos_shadow_activate_rpc/);
  assert.doesNotMatch(source, /activate_department_head_writes/);
  assert.doesNotMatch(source, /sendEmail\s*\(/);
  assert.doesNotMatch(source, /resend\.emails/);
  assert.doesNotMatch(source, /api\.telnyx\.com/);
  const authMount = server.indexOf("app.use('/api', authMiddleware, tenantMiddleware);");
  const tripwire = server.indexOf(
    "app.use('/api', require('./middleware/cross-tenant-tripwire'));",
  );
  const acceptance = server.indexOf(
    "app.use('/api/department-report-acceptance'",
  );
  assert.ok(authMount >= 0 && tripwire > authMount && acceptance > tripwire);
});
