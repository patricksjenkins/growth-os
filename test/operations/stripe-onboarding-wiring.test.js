'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '..', '..', 'integrations', 'stripe.js'),
  'utf8'
);

test('Stripe preserves deployed onboarding before projecting the canonical handoff', () => {
  const start = source.indexOf('const workflow = await startOnboarding');
  const project = source.indexOf('projectStripeClosedWonOnboarding');
  const welcome = source.indexOf('sendWelcomeWizard', project);

  assert.ok(start >= 0);
  assert.ok(project > start);
  assert.ok(welcome > project);
});

test('canonical handoff failure is isolated and emits no customer payload', () => {
  assert.match(source, /Canonical closed-won onboarding handoff failed closed/);
  assert.match(source, /closed_won_onboarding_handoff_failed/);
  assert.match(source, /payload:\s*\{\}/);

  const canonicalBlock = source.slice(
    source.indexOf('let closed_won_handoff'),
    source.indexOf('// Send the dual-platform welcome wizard')
  );
  assert.doesNotMatch(canonicalBlock, /customer_email|customer_details|raw_event|session\.metadata/);
});
