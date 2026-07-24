'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'scripts', 'autonomous-os-baseline.js'),
  'utf8'
);

test('production baseline script is aggregate-only and contains no write operations', () => {
  assert.match(source, /count:\s*'exact'/);
  assert.match(source, /head:\s*true/);
  assert.doesNotMatch(source, /\.(insert|update|delete|upsert|rpc)\s*\(/);
  assert.doesNotMatch(source, /select\(['"`][^'"`]*(name|email|phone|amount|credentials|payload|body)/i);
});
