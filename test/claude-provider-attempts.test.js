'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { providerAttempts } = require('../integrations/claude');

test('Claude transport attempts are bounded to one through three', () => {
  assert.equal(providerAttempts(1), 1);
  assert.equal(providerAttempts(2), 2);
  assert.equal(providerAttempts(3), 3);
  assert.equal(providerAttempts(0), 1);
  assert.equal(providerAttempts(99), 3);
  assert.equal(providerAttempts('unavailable'), 3);
});
