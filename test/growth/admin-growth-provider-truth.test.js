'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Growth evidence readout surfaces a rejected headcount provider instead of false green', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../api/routes/admin-growth.js'), 'utf8');
  assert.match(source, /contains\('payload', \{ evidence_recovery: true \}\)/);
  assert.match(source, /employee_evidence_provider_rejected/);
  assert.match(source, /credential_accepted: employeeProviderRejected \? false : null/);
});
