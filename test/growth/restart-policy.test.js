'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FGA_TENANT_ID } = require('../../core/config');
const { classifyRestartCandidate } = require('../../core/growth/restart-policy');

const goodLead = {
  lead_source: 'prospecting_agent', status: 'contacted', lifecycle_stage: 'sequenced',
  employee_count_actual: 5, lead_score: 78, outreach_ready: true,
  metadata: { employee_count_evidence: { count: 5, source: 'public registry', confidence: 0.9 } },
};
const safeContext = {
  hasEmail: true, customerMatch: false, suppressed: false,
  negativeDelivery: false, humanReply: false, lastAcceptedAt: '2026-05-01T12:00:00Z',
};
const now = new Date('2026-09-05T12:00:00Z');

test('only the FGA tenant can produce a restart authorization', () => {
  assert.equal(classifyRestartCandidate({ tenantId: FGA_TENANT_ID, lead: goodLead, context: safeContext, now }).decision, 'eligible');
  assert.equal(classifyRestartCandidate({ tenantId: 'customer-tenant', lead: goodLead, context: safeContext, now }).reason, 'wrong_tenant');
});

test('unknown headcount returns to evidence; 10 employees is excluded', () => {
  assert.equal(classifyRestartCandidate({ tenantId: FGA_TENANT_ID, lead: { ...goodLead, employee_count_actual: null }, context: safeContext, now }).decision, 'needs_evidence');
  assert.equal(classifyRestartCandidate({ tenantId: FGA_TENANT_ID, lead: { ...goodLead, employee_count_actual: 10 }, context: safeContext, now }).reason, 'employee_count_10_or_more');
});

test('replies, suppressions, customer matches, and recent sends are never restarted', () => {
  for (const [key, reason] of [
    ['humanReply', 'human_reply_history'], ['suppressed', 'suppressed'],
    ['customerMatch', 'matches_customer'], ['negativeDelivery', 'negative_delivery_history'],
  ]) {
    const result = classifyRestartCandidate({ tenantId: FGA_TENANT_ID, lead: goodLead, context: { ...safeContext, [key]: true }, now });
    assert.equal(result.reason, reason);
  }
  const recent = classifyRestartCandidate({
    tenantId: FGA_TENANT_ID, lead: goodLead,
    context: { ...safeContext, lastAcceptedAt: '2026-08-20T12:00:00Z' }, now,
  });
  assert.equal(recent.reason, 'cooldown_active');
});

test('fresh qualified prospects and dormant qualified prospects form separate cohorts', () => {
  const fresh = classifyRestartCandidate({ tenantId: FGA_TENANT_ID, lead: { ...goodLead, status: 'new_lead', lifecycle_stage: 'scored' }, context: { ...safeContext, lastAcceptedAt: null }, now });
  const dormant = classifyRestartCandidate({ tenantId: FGA_TENANT_ID, lead: goodLead, context: safeContext, now });
  assert.equal(fresh.reason, 'fresh_qualified_prospect');
  assert.equal(dormant.reason, 'dormant_qualified_prospect');
});
