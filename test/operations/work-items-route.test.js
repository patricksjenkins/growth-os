'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const route = require('../../api/routes/work-items');

const {
  parseListQuery,
  requireControlPlane,
  sortItems,
} = route._internal;
const TENANT_A = '11111111-1111-4111-8111-111111111111';

function withFlag(value, fn) {
  const key = 'FGA_OS_CONTROL_PLANE_API_ENABLED';
  const cohortKey = 'FGA_OS_CONTROL_PLANE_TENANT_ALLOWLIST';
  const previous = process.env[key];
  const previousCohort = process.env[cohortKey];
  try {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    process.env[cohortKey] = TENANT_A;
    return fn();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
    if (previousCohort === undefined) delete process.env[cohortKey];
    else process.env[cohortKey] = previousCohort;
  }
}

test('list filters are allowlisted and limits are bounded', () => {
  assert.deepEqual(parseListQuery({
    kind: 'decision',
    status: 'open',
    priority: 'critical',
    department: 'Executive',
    limit: '1000',
  }), {
    valid: true,
    errors: [],
    value: {
      limit: 100,
      kind: 'decision',
      status: 'open',
      priority: 'critical',
      department: 'Executive',
      includeClosed: false,
    },
  });
  assert.deepEqual(
    parseListQuery({ kind: 'sql', status: 'anything', priority: 'urgent' }).errors,
    ['invalid_kind', 'invalid_status', 'invalid_priority']
  );
});

test('work items are deterministically ordered by priority, due date, then recency', () => {
  const sorted = sortItems([
    { id: 'normal', priority: 'normal', due_at: null, created_at: '2026-07-24T10:00:00Z' },
    { id: 'critical-later', priority: 'critical', due_at: '2026-07-26T10:00:00Z', created_at: '2026-07-24T10:00:00Z' },
    { id: 'critical-sooner', priority: 'critical', due_at: '2026-07-25T10:00:00Z', created_at: '2026-07-24T10:00:00Z' },
  ]);
  assert.deepEqual(sorted.map(item => item.id), [
    'critical-sooner',
    'critical-later',
    'normal',
  ]);
});

test('the entire route is indistinguishable from missing while the flag is off', () => {
  const result = { status: null, body: null, next: false };
  const res = {
    status(code) {
      result.status = code;
      return this;
    },
    json(body) {
      result.body = body;
      return this;
    },
  };
  const req = {
    tenantId: TENANT_A,
    user: { app_metadata: { tenant_id: TENANT_A, role: 'client_owner' } },
  };
  withFlag(undefined, () => requireControlPlane(req, res, () => { result.next = true; }));
  assert.equal(result.status, 404);
  assert.equal(result.next, false);

  withFlag('true', () => requireControlPlane(req, res, () => { result.next = true; }));
  assert.equal(result.next, true);
});

test('current authoritative client-owner and tenant-owner roles are accepted, stale roles denied', () => {
  for (const role of ['client_owner', 'tenant_owner']) {
    let next = false;
    withFlag('true', () => requireControlPlane({
      tenantId: TENANT_A,
      user: { app_metadata: { tenant_id: TENANT_A, role } },
    }, {
      status() { return this; },
      json() { return this; },
    }, () => { next = true; }));
    assert.equal(next, true);
  }

  let status = null;
  withFlag('true', () => requireControlPlane({
    tenantId: TENANT_A,
    user: { app_metadata: { tenant_id: TENANT_A, role: 'member' } },
  }, {
    status(code) { status = code; return this; },
    json() { return this; },
  }, () => {}));
  assert.equal(status, 403);
});

test('server mounts the work queue only below authenticated tenant middleware and tripwire', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'api', 'server.js'),
    'utf8'
  );
  const authMount = source.indexOf("app.use('/api', authMiddleware, tenantMiddleware);");
  const tripwire = source.indexOf("app.use('/api', require('./middleware/cross-tenant-tripwire'));");
  const workItems = source.indexOf("app.use('/api/work-items', require('./routes/work-items'));");
  assert.ok(authMount >= 0 && tripwire > authMount && workItems > tripwire);
});
