'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { scanTrackedFiles } = require('../scripts/check-secrets');

const root = path.join(__dirname, '..');

test('tracked source contains no service-role JWT or private key', () => {
  assert.deepEqual(scanTrackedFiles(root), []);
});

test('Docker build context excludes credentials and local dependency trees', () => {
  const dockerignore = fs.readFileSync(path.join(root, '.dockerignore'), 'utf8');
  for (const required of ['.env', '**/.env', '**/credentials.json', '**/*.mobileprovision', '**/node_modules']) {
    assert.ok(
      dockerignore.split(/\r?\n/).includes(required),
      `.dockerignore must include ${required}`
    );
  }
});

test('server honors Railway PORT without removing the API_PORT override', () => {
  const server = fs.readFileSync(path.join(root, 'api', 'server.js'), 'utf8');
  assert.match(server, /process\.env\.API_PORT\s*\|\|\s*process\.env\.PORT\s*\|\|\s*3000/);
});
