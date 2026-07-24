'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const route = require('../api/routes/documents');

const { parseDocumentFilters, requireDocumentCenter } = route._internal;
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const USER_A = 'eeeeeeee-1111-4111-8111-111111111111';

function withFlag(value, fn) {
  const key = 'FGA_OS_DOCUMENT_CENTER_API_ENABLED';
  const cohortKey = 'FGA_OS_DOCUMENT_CENTER_TENANT_ALLOWLIST';
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

test('document filters are allowlisted and bounded', () => {
  assert.deepEqual(parseDocumentFilters({
    status: 'published',
    classification: 'client',
    document_type: 'brochure',
    tag: ' Sales ',
    limit: '500',
  }), {
    valid: true,
    errors: [],
    value: {
      status: 'published',
      classification: 'client',
      documentType: 'brochure',
      tag: 'sales',
      includeRetired: false,
      limit: 100,
    },
  });
  assert.deepEqual(
    parseDocumentFilters({ status: 'live', classification: 'secret' }).errors,
    ['invalid_status', 'invalid_classification']
  );
});

test('Document Center route is hidden while its API flag is off', () => {
  const result = { status: null, next: false };
  const res = {
    status(code) {
      result.status = code;
      return this;
    },
    json() {
      return this;
    },
  };
  const req = {
    tenantId: TENANT_A,
    userId: USER_A,
    user: { id: USER_A, app_metadata: { tenant_id: TENANT_A, role: 'tenant_owner' } },
  };
  withFlag(undefined, () => requireDocumentCenter(req, res, () => { result.next = true; }));
  assert.equal(result.status, 404);
  assert.equal(result.next, false);
  withFlag('true', () => requireDocumentCenter(req, res, () => { result.next = true; }));
  assert.equal(result.next, true);
});

test('current tenant document roles reach RLS while mismatched and unknown roles fail early', () => {
  for (const role of ['client_owner', 'tenant_owner', 'manager', 'member', 'viewer']) {
    let next = false;
    withFlag('true', () => requireDocumentCenter({
      tenantId: TENANT_A,
      userId: USER_A,
      user: { id: USER_A, app_metadata: { tenant_id: TENANT_A, role } },
    }, {
      status() { return this; },
      json() { return this; },
    }, () => { next = true; }));
    assert.equal(next, true);
  }

  for (const appMetadata of [
    { tenant_id: TENANT_A, role: 'agent' },
    { tenant_id: '22222222-2222-4222-8222-222222222222', role: 'client_owner' },
  ]) {
    let status = null;
    withFlag('true', () => requireDocumentCenter({
      tenantId: TENANT_A,
      userId: USER_A,
      user: { id: USER_A, app_metadata: appMetadata },
    }, {
      status(code) { status = code; return this; },
      json() { return this; },
    }, () => {}));
    assert.equal(status, 403);
  }
});

test('document metadata and search mount below tenant auth and the tripwire', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'api', 'server.js'),
    'utf8'
  );
  const authMount = source.indexOf("app.use('/api', authMiddleware, tenantMiddleware);");
  const tripwire = source.indexOf("app.use('/api', require('./middleware/cross-tenant-tripwire'));");
  const documents = source.indexOf("app.use('/api/documents', require('./routes/documents'));");
  assert.ok(authMount >= 0 && tripwire > authMount && documents > tripwire);
});

test('read API exposes no object path, source URL, download, upload, or mutation route', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'api', 'routes', 'documents.js'),
    'utf8'
  );
  assert.doesNotMatch(source, /storage_path/);
  assert.doesNotMatch(source, /source_url/);
  assert.doesNotMatch(source, /\.select\(['"]\*['"]\)/);
  assert.doesNotMatch(source, /router\.(post|put|patch|delete)\(/);
  assert.doesNotMatch(source, /createSignedUrl|upload\(/);
});
