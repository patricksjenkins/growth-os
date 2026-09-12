'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { FGA_TENANT_ID } = require('../../core/config');
const {
  supplyProviderCallDailyCap,
  supplyProviderCostDailyCapUsd,
  qualityJudgmentDailyCap,
  readFgaSupplyUsageBudget,
  readFgaQualityJudgmentBudget,
} = require('../../core/growth/workload-policy');

function usageClient({ rows = [], count = rows.length, error = null } = {}) {
  return {
    from(table) {
      assert.equal(table, 'ai_usage_events');
      const builder = {};
      for (const method of ['select', 'eq', 'in', 'gte', 'lt', 'limit']) {
        builder[method] = () => builder;
      }
      builder.then = (resolve) => resolve({ data: rows, count, error });
      return builder;
    },
  };
}

test('FGA speculative-supply limits are bounded and have conservative defaults', () => {
  assert.equal(supplyProviderCallDailyCap(undefined), 200);
  assert.equal(supplyProviderCallDailyCap('1'), 25);
  assert.equal(supplyProviderCallDailyCap('5000'), 1000);
  assert.equal(supplyProviderCostDailyCapUsd(undefined), 2.5);
  assert.equal(supplyProviderCostDailyCapUsd('0'), 0.5);
  assert.equal(supplyProviderCostDailyCapUsd('500'), 50);
  assert.equal(qualityJudgmentDailyCap(undefined), 25);
  assert.equal(qualityJudgmentDailyCap('500'), 100);
});

test('FGA supply budget stops on either call volume or estimated cost', async () => {
  const byCalls = await readFgaSupplyUsageBudget(
    usageClient({ rows: [], count: 200 }),
    FGA_TENANT_ID,
    new Date('2026-09-12T12:00:00Z'),
  );
  assert.equal(byCalls.exhausted, true);
  assert.equal(byCalls.reason, 'supply_call_budget_exhausted');
  assert.equal(byCalls.estimated_cost_usd, null);
  assert.equal(byCalls.cost_complete, false);

  const byCost = await readFgaSupplyUsageBudget(
    usageClient({ rows: [{ estimated_cost_usd: 1.5 }, { estimated_cost_usd: 1.0 }] }),
    FGA_TENANT_ID,
    new Date('2026-09-12T12:00:00Z'),
  );
  assert.equal(byCost.exhausted, true);
  assert.equal(byCost.reason, 'supply_cost_budget_exhausted');
  assert.equal(byCost.estimated_cost_usd, 2.5);
  assert.equal(byCost.cost_complete, true);
});

test('quality judgments are capped daily without applying the policy to customers', async () => {
  const budget = await readFgaQualityJudgmentBudget(
    usageClient({ rows: [], count: 25 }),
    FGA_TENANT_ID,
    new Date('2026-09-12T12:00:00Z'),
  );
  assert.equal(budget.exhausted, true);
  assert.equal(budget.remaining_judgments, 0);

  const customer = await readFgaQualityJudgmentBudget(
    usageClient(),
    'customer-tenant',
  );
  assert.deepEqual(customer, {
    applicable: false,
    available: true,
    exhausted: false,
    reason: 'customer_tenant_unchanged',
  });
});

test('unverifiable budget evidence fails closed for new resource consumption', async () => {
  const supply = await readFgaSupplyUsageBudget(
    usageClient({ error: { message: 'unavailable' } }),
    FGA_TENANT_ID,
  );
  const quality = await readFgaQualityJudgmentBudget(
    usageClient({ error: { message: 'unavailable' } }),
    FGA_TENANT_ID,
  );
  assert.equal(supply.available, false);
  assert.equal(supply.exhausted, true);
  assert.equal(supply.remaining_calls, 0);
  assert.equal(quality.available, false);
  assert.equal(quality.exhausted, true);
  assert.equal(quality.remaining_judgments, 0);
});
