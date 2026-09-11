'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const source = fs.readFileSync(require.resolve('../worker/agents/outreach.js'), 'utf8');

test('cold outreach treats the product catalog as a private one-angle menu', () => {
  assert.match(source, /private menu for choosing ONE angle/);
  assert.match(source, /ONE means exactly one/);
  assert.match(source, /must not mention a\s+second capability/);
});

test('cold outreach forbids the vague automation and zero-effort claims rejected in production preflight', () => {
  assert.match(source, /never promise zero owner involvement/i);
  assert.match(source, /instead of the vague phrase "follows up\s+automatically/);
  assert.match(source, /never combine lead\s+capture, follow-up, social publishing, or review requests/i);
});
