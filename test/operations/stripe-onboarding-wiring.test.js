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

  // The old end marker ("Send the dual-platform welcome wizard") was removed
  // when the auto-send was cut — with indexOf returning -1 the slice swallowed
  // the rest of the file and this test failed on code outside the block. The
  // boundary is now the no-auto-send declaration that replaced it, and its
  // absence is a hard failure rather than a silent mis-slice.
  const endMarker = source.indexOf('DO NOT send the welcome email here');
  assert.ok(endMarker > 0, 'the canonical block boundary moved — update this test');
  const canonicalBlock = source.slice(
    source.indexOf('let closed_won_handoff'),
    endMarker
  );
  assert.doesNotMatch(canonicalBlock, /customer_email|customer_details|raw_event|session\.metadata/);
});
