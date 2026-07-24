'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEPARTMENT_KEYS,
  departmentContract,
  listDepartmentContracts,
  evaluateDepartmentAction,
} = require('../../core/departments/catalog');

test('catalog defines all seven required Department Heads', () => {
  assert.deepEqual(DEPARTMENT_KEYS, [
    'reliability',
    'revenue',
    'onboarding',
    'client_success',
    'finance',
    'marketing',
    'product_engineering',
  ]);
  const contracts = listDepartmentContracts();
  assert.equal(contracts.length, 7);
  for (const contract of contracts) {
    assert.ok(contract.mission.length > 20);
    assert.ok(contract.kpis.length >= 5);
    assert.ok(contract.acceptedReportTypes.length >= 4);
    assert.ok(contract.supervisedActions.includes('assign_supervised_work'));
    assert.ok(contract.supervisedActions.includes('escalate_exception')
      || contract.supervisedActions.includes('escalate_blocked_prerequisite'));
    assert.ok(contract.ownerApprovalActions.length >= 4);
    assert.ok(contract.prohibitedActions.length >= 3);
    assert.equal(contract.executionMode, 'shadow');
    assert.equal(contract.productionWriteAuthority, false);
  }
});

test('catalog returns copies that cannot mutate canonical authority', () => {
  const first = departmentContract('reliability');
  first.executionMode = 'autonomous';
  first.supervisedActions.push('deploy_production');

  const second = departmentContract('reliability');
  assert.equal(second.executionMode, 'shadow');
  assert.equal(second.productionWriteAuthority, false);
  assert.doesNotMatch(second.supervisedActions.join(','), /deploy_production/);
});

test('every production and customer-impact boundary requires owner approval', () => {
  const actions = [
    'deploy_production',
    'apply_production_migration',
    'send_customer_email',
    'send_customer_sms',
    'place_customer_voice_call',
    'publish_public_content',
    'move_money',
    'charge_customer',
    'refund_customer',
    'change_pricing',
    'release_app_store_build',
    'activate_production_write_authority',
  ];
  for (const department of DEPARTMENT_KEYS) {
    for (const action of actions) {
      assert.deepEqual(evaluateDepartmentAction(department, action), {
        decision: 'owner_approval_required',
        reason: 'production_or_owner_boundary',
      });
    }
  }
});

test('universal safety violations and unknown actions fail closed', () => {
  for (const department of DEPARTMENT_KEYS) {
    assert.equal(evaluateDepartmentAction(department, 'cross_tenant_access').decision, 'deny');
    assert.equal(evaluateDepartmentAction(department, 'fabricate_evidence').decision, 'deny');
    assert.equal(evaluateDepartmentAction(department, 'something_new').decision, 'deny');
    assert.equal(evaluateDepartmentAction(department, '').decision, 'deny');
  }
});

test('only registered supervised work receives shadow authority', () => {
  assert.deepEqual(evaluateDepartmentAction('product_engineering', 'run_verification'), {
    decision: 'allow_shadow',
    reason: 'supervised_contract',
  });
  assert.deepEqual(evaluateDepartmentAction('finance', 'move_money'), {
    decision: 'owner_approval_required',
    reason: 'production_or_owner_boundary',
  });
  assert.deepEqual(evaluateDepartmentAction('marketing', 'invent_customer_proof'), {
    decision: 'deny',
    reason: 'prohibited_action',
  });
});

test('unknown department cannot inherit a permissive default', () => {
  assert.throws(
    () => departmentContract('executive'),
    /Unknown department contract/,
  );
  assert.throws(
    () => evaluateDepartmentAction('sales-ish', 'assign_supervised_work'),
    /Unknown department contract/,
  );
});
