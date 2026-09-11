'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isSyntheticGrowthLead } = require('../../core/growth/production-evidence');

test('synthetic production fixtures never become business outcomes', () => {
  assert.equal(isSyntheticGrowthLead({ metadata: { synthetic: true } }), true);
  assert.equal(isSyntheticGrowthLead({ metadata: { is_test: 'true' } }), true);
  assert.equal(isSyntheticGrowthLead({ lead_source: 'fixture' }), true);
  assert.equal(isSyntheticGrowthLead({ email: 'owner@example.test' }), true);
});

test('an ordinary sourced prospect remains eligible for evidence', () => {
  assert.equal(isSyntheticGrowthLead({
    email: 'owner@real-business.com', lead_source: 'prospecting_agent', metadata: {},
  }), false);
});

test('a quarantined automated intake can never become a business outcome', () => {
  assert.equal(isSyntheticGrowthLead({
    email: 'person@business.com',
    lead_source: 'website_demo_request',
    metadata: { intake_safety: { contact_allowed: false } },
  }), true);
});
