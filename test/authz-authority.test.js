'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  CONSOLIDATED_APPROVAL_ACTIONS,
  evaluateAuthority,
} = require('../core/authz/authority');

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

function human(role = 'client_owner') {
  return {
    type: 'human',
    id: 'eeeeeeee-1111-4111-8111-111111111111',
    role,
    tenantId: TENANT_A,
  };
}

test('tenant-owner work commands and member document reads follow one action contract', () => {
  assert.equal(evaluateAuthority({
    actor: human(),
    action: 'work_item.transition',
    targetTenantId: TENANT_A,
  }).allowed, true);
  assert.equal(evaluateAuthority({
    actor: human('member'),
    action: 'work_item.transition',
    targetTenantId: TENANT_A,
  }).allowed, false);
  assert.equal(evaluateAuthority({
    actor: human('member'),
    action: 'document.read',
    targetTenantId: TENANT_A,
  }).allowed, true);
  assert.equal(evaluateAuthority({
    actor: human(),
    action: 'department.read',
    targetTenantId: TENANT_A,
  }).allowed, true);
  assert.equal(evaluateAuthority({
    actor: human('member'),
    action: 'department.read',
    targetTenantId: TENANT_A,
  }).allowed, false);
});

test('a permitted role still fails closed for another tenant', () => {
  const result = evaluateAuthority({
    actor: human(),
    action: 'work_item.read',
    targetTenantId: TENANT_B,
  });
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.includes('tenant_mismatch'));
});

test('agents and services cannot impersonate human tenant roles', () => {
  for (const type of ['agent', 'service', 'system']) {
    const result = evaluateAuthority({
      actor: { ...human(), type },
      action: 'document.read',
      targetTenantId: TENANT_A,
    });
    assert.equal(result.allowed, false);
    assert.ok(result.reasons.includes('human_authority_required'));
  }
});

test('every production-boundary action is approval-required and never allowed', () => {
  for (const action of CONSOLIDATED_APPROVAL_ACTIONS) {
    const result = evaluateAuthority({
      actor: human('owner'),
      action,
      targetTenantId: TENANT_A,
    });
    assert.equal(result.allowed, false, action);
    assert.equal(result.decision, 'approval_required', action);
    assert.ok(result.reasons.includes('consolidated_approval_required'), action);
  }
});

test('unknown actions fail closed', () => {
  const result = evaluateAuthority({
    actor: human(),
    action: 'make_everything_green',
    targetTenantId: TENANT_A,
  });
  assert.deepEqual(result, {
    allowed: false,
    decision: 'deny',
    action: 'make_everything_green',
    reasons: ['unknown_action'],
  });
});
