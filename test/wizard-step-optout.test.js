'use strict';

/**
 * Choosing what the customer's wizard asks for.
 *
 * Patrick fills what he can in the Onboarding Center; the wizard collects the
 * rest. Anything he already has should not be asked for again — being asked
 * twice for something you already handed over reads as nobody paying
 * attention.
 *
 * The assertion that matters most is the one about `agreement`. It captures
 * the customer's acceptance of the service terms, their typed signature, the
 * document versions and their IP. Consent cannot be given on someone's behalf
 * by ticking a box in an admin panel, so no combination of settings may drop
 * it.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const resolver = require('../core/onboarding-step-resolver');

const { resolveApplicableSteps, NON_SKIPPABLE, STEP_FIELDS, skippableSteps } = resolver;

// A Scale-ish module set, so most conditional steps are in play.
const MODULES = [
  'content_engine', 'approval_queue', 'publishing', 'review_request',
  'lead_capture', 'follow_up', 'referral_engine', 'website', 'chat_agent',
];

test('by default the customer is asked everything their modules call for', () => {
  const steps = resolveApplicableSteps(MODULES, 'managed');
  assert.ok(steps.includes('logo'));
  assert.ok(steps.includes('colors'));
  assert.ok(steps.includes('gbp'), 'they bought review requests');
  assert.ok(steps.includes('dfy_website'), 'they bought a website');
  assert.ok(steps.includes('agreement'));
});

test('a step switched off is not asked for', () => {
  const steps = resolveApplicableSteps(MODULES, 'managed', { excluded: ['logo', 'colors'] });
  assert.ok(!steps.includes('logo'));
  assert.ok(!steps.includes('colors'));
  // and the rest is untouched
  assert.ok(steps.includes('services'));
});

test('THE AGREEMENT CANNOT BE SWITCHED OFF', () => {
  // Every route to dropping it, refused.
  const viaExclusion = resolveApplicableSteps(MODULES, 'managed', { excluded: ['agreement'] });
  assert.ok(viaExclusion.includes('agreement'),
    'consent cannot be given on the customer behalf from an admin panel');

  const viaEverything = resolveApplicableSteps(MODULES, 'managed', {
    excluded: resolver.STEP_DEFINITIONS.map((d) => d.key),
  });
  assert.ok(viaEverything.includes('agreement'), 'not even by excluding everything');

  // And pre-filling cannot drop it either, because it collects no config field
  // this resolver knows how to satisfy.
  const viaConfig = resolveApplicableSteps(MODULES, 'managed', {
    config: { agreement_accepted_at: '2026-01-01', agreement_signature: 'Jane' },
  });
  assert.ok(viaConfig.includes('agreement'));
});

test('the wizard bookends survive too', () => {
  const steps = resolveApplicableSteps(MODULES, 'managed', {
    excluded: ['welcome', 'complete'],
  });
  assert.ok(steps.includes('welcome'));
  assert.ok(steps.includes('complete'));
  assert.deepStrictEqual([...NON_SKIPPABLE].sort(), ['agreement', 'complete', 'welcome']);
});

test('a step Patrick already filled in is not asked again', () => {
  const steps = resolveApplicableSteps(MODULES, 'managed', {
    config: { logo_url: 'https://cdn/logo.png', color_primary: '#2C5AA0' },
  });
  assert.ok(!steps.includes('logo'), 'he has the logo');
  assert.ok(!steps.includes('colors'), 'he has the colours');
  assert.ok(steps.includes('services'), 'but not the services');
});

test('a half-filled step still asks — a partial answer is not an answer', () => {
  // `social` collects both Facebook and Instagram.
  const steps = resolveApplicableSteps(MODULES, 'managed', {
    config: { facebook_url: 'https://facebook.com/x' },
  });
  assert.ok(steps.includes('social'),
    'having one of the two is not having the step');

  const both = resolveApplicableSteps(MODULES, 'managed', {
    config: { facebook_url: 'https://facebook.com/x', instagram_url: 'https://instagram.com/x' },
  });
  assert.ok(!both.includes('social'));
});

test('an empty array does not count as filled in', () => {
  // `customers: []` is what a wizard save writes when they had nobody. It
  // must not read as "we have their customer list".
  const steps = resolveApplicableSteps(MODULES, 'managed', { config: { customers: [] } });
  assert.ok(steps.includes('customers'));
});

test('switching a step off never widens the list', () => {
  // Guard against an exclusion accidentally re-including something irrelevant.
  const base = resolveApplicableSteps(MODULES, 'managed');
  const off = resolveApplicableSteps(MODULES, 'managed', { excluded: ['logo'] });
  assert.ok(off.every((s) => base.includes(s)));
  assert.strictEqual(off.length, base.length - 1);
});

test('relevance still wins — turning off a step they never had is a no-op', () => {
  // No voice_receptionist module, so that step was never asked for anyway.
  const steps = resolveApplicableSteps(['lead_capture'], 'managed', {
    excluded: ['voice_receptionist'],
  });
  assert.ok(!steps.includes('voice_receptionist'));
  assert.ok(steps.includes('agreement'));
});

test('the pickable list excludes exactly the protected steps', () => {
  const pickable = skippableSteps();
  for (const k of NON_SKIPPABLE) {
    assert.ok(!pickable.includes(k), `${k} must not be offered as switchable`);
  }
  assert.ok(pickable.includes('logo'));
  assert.ok(pickable.length > 5);
});

test('every switchable step declares what it collects', () => {
  // Without this map a step can never be auto-satisfied, so the opt-out would
  // silently only half-work.
  for (const key of skippableSteps()) {
    assert.ok(STEP_FIELDS[key] && STEP_FIELDS[key].length > 0,
      `${key} is switchable but declares no fields — it can never auto-satisfy`);
  }
});
