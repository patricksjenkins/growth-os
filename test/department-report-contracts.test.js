'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  listReportContractDefinitions,
  reportContractDefinition,
} = require('../core/departments/report-contracts');

test('all seven Department Heads have a deterministic canonical report contract', () => {
  const tenantId = '11111111-1111-4111-8111-111111111111';
  const contracts = listReportContractDefinitions();
  assert.equal(contracts.length, 7);
  assert.equal(new Set(contracts.map(row => row.department)).size, 7);
  for (const contract of contracts) {
    assert.match(contract.schemaDigest, /^[a-f0-9]{64}$/);
    assert.match(contract.contractIdForTenant(tenantId), /^[0-9a-f-]{36}$/);
    assert.equal(contract.definition.evidence_policy.exact_tenant_required, true);
    assert.equal(contract.definition.evidence_policy.contact_data_forbidden, true);
    assert.equal(contract.definition.evidence_policy.owner_acceptance_required, true);
  }
});

test('Revenue contract names its accepted outcomes and cannot become a send authority', () => {
  const revenue = reportContractDefinition('revenue');
  assert.equal(revenue.department, 'revenue_sales');
  assert.ok(revenue.definition.kpis.includes('qualified_replies_per_week'));
  assert.ok(revenue.definition.accepted_report_types.includes('conversion_cohort_report'));
  assert.equal(Object.hasOwn(revenue.definition, 'send'), false);
  assert.equal(Object.hasOwn(revenue.definition, 'dispatch'), false);
});
