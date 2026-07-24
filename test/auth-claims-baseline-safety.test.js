'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'scripts', 'auth-claims-baseline.js'),
  'utf8'
);

test('auth claim audit is read-only and never prints identity fields', () => {
  assert.match(source, /auth\.admin\.listUsers/);
  assert.doesNotMatch(source, /auth\.admin\.(updateUserById|deleteUser|createUser)/);
  assert.doesNotMatch(source, /\.(insert|update|delete|upsert|rpc)\s*\(/);
  assert.doesNotMatch(source, /console\.log\([^)]*(email|user\.id|tenant_id)/);
});
