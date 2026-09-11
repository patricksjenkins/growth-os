'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  FGA_DEMO_CAPTURE_SCHEMA,
  assessFgaDemoCapture,
  automatedContactAllowed,
} = require('../../core/growth/intake-safety');

const NOW = Date.parse('2026-09-11T12:00:00Z');

function valid(overrides = {}) {
  return {
    capture_schema: FGA_DEMO_CAPTURE_SCHEMA,
    sms_consent: true,
    form_started_at: NOW - 45_000,
    message: 'I want to see how lead follow-up works.',
    website: '',
    ...overrides,
  };
}

test('a consented human-paced FGA demo form is contactable', () => {
  const result = assessFgaDemoCapture(valid(), { now: NOW });
  assert.equal(result.accepted, true);
  assert.equal(result.contact_allowed, true);
  assert.deepEqual(result.reasons, []);
});

test('a filled honeypot is acknowledged but never persisted or contacted', () => {
  const result = assessFgaDemoCapture(valid({ website: 'https://spam.invalid' }), { now: NOW });
  assert.equal(result.accepted, false);
  assert.equal(result.silent_drop, true);
  assert.equal(result.contact_allowed, false);
  assert.deepEqual(result.reasons, ['honeypot_filled']);
});

test('the reproduced numeric-message burst is quarantined before any agent acts', () => {
  const result = assessFgaDemoCapture(valid({ message: '1234567890' }), { now: NOW });
  assert.equal(result.accepted, true, 'retain the row as audit evidence');
  assert.equal(result.contact_allowed, false);
  assert.ok(result.reasons.includes('numeric_only_free_text'));
});

test('missing consent, schema, or credible elapsed time fails closed', () => {
  const result = assessFgaDemoCapture({ message: 'Please call me' }, { now: NOW });
  assert.equal(result.contact_allowed, false);
  assert.deepEqual(new Set(result.reasons), new Set([
    'capture_schema_missing', 'sms_consent_unproven', 'form_timing_missing',
  ]));
});

test('quarantine metadata is the shared no-contact contract', () => {
  assert.equal(automatedContactAllowed({ metadata: {} }), true);
  assert.equal(automatedContactAllowed({ metadata: { intake_safety: { contact_allowed: false } } }), false);
});
