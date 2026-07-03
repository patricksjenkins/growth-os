'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { isBillingActive } = require('../core/revenue');

const NOW = Date.parse('2026-07-02T00:00:00Z');
const past = '2026-06-18T00:00:00Z';
const future = '2026-07-20T00:00:00Z';

test('billing-active-but-still-onboarding counts toward MRR', () => {
  // 923A Coins: admin-onboarded, delivery still "onboarding", but the Stripe
  // subscription is charging them. Flag set → must count.
  assert.strictEqual(
    isBillingActive({ isComplimentary: false, monthlyRate: 499, status: 'onboarding', billingActiveFlag: true }, NOW),
    true,
  );
});

test('operationally-live customer with no billing flags still counts', () => {
  assert.strictEqual(
    isBillingActive({ isComplimentary: false, monthlyRate: 23, status: 'active' }, NOW),
    true,
  );
});

test('trial converted (trial_ends_at in the past) counts even without a webhook', () => {
  assert.strictEqual(
    isBillingActive({ isComplimentary: false, monthlyRate: 249, status: 'onboarding', trialEndsAt: past }, NOW),
    true,
  );
});

test('active Stripe subscription status counts', () => {
  assert.strictEqual(
    isBillingActive({ isComplimentary: false, monthlyRate: 399, status: 'onboarding', subscriptionStatus: 'active' }, NOW),
    true,
  );
});

test('past_due still counts (dunning, not yet churned)', () => {
  assert.strictEqual(
    isBillingActive({ isComplimentary: false, monthlyRate: 399, status: 'active', subscriptionStatus: 'past_due' }, NOW),
    true,
  );
});

test('complimentary tenant never counts', () => {
  assert.strictEqual(
    isBillingActive({ isComplimentary: true, monthlyRate: 0, status: 'active', billingActiveFlag: true }, NOW),
    false,
  );
});

test('still-in-trial (not yet converted) does NOT count', () => {
  assert.strictEqual(
    isBillingActive({ isComplimentary: false, monthlyRate: 249, status: 'onboarding', subscriptionStatus: 'trialing', trialEndsAt: future }, NOW),
    false,
  );
});

test('onboarding tenant with no billing signal at all does NOT count', () => {
  // WellMor-style: inactive/onboarding, no trial, no sub, no flag.
  assert.strictEqual(
    isBillingActive({ isComplimentary: false, monthlyRate: 1, status: 'inactive' }, NOW),
    false,
  );
});

test('churned tenant never counts, even if a stale billing flag lingers', () => {
  assert.strictEqual(
    isBillingActive({ isComplimentary: false, monthlyRate: 499, status: 'active', billingActiveFlag: true, churnedAt: past }, NOW),
    false,
  );
});

test('canceled Stripe subscription never counts, even if operationally active', () => {
  assert.strictEqual(
    isBillingActive({ isComplimentary: false, monthlyRate: 499, status: 'active', subscriptionStatus: 'canceled' }, NOW),
    false,
  );
});

test('zero / missing monthly rate does not count', () => {
  assert.strictEqual(isBillingActive({ isComplimentary: false, monthlyRate: 0, status: 'active' }, NOW), false);
  assert.strictEqual(isBillingActive({ isComplimentary: false, status: 'active' }, NOW), false);
});
