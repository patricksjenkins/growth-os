'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SALES_DEPARTMENT,
  buildSalesDepartmentReport,
} = require('../core/revenue/sales-department');

test('Revenue & Sales has one accountable head, named teams, and a Chief of Staff report contract', () => {
  assert.equal(SALES_DEPARTMENT.head.role, 'Chief Revenue Agent');
  assert.equal(SALES_DEPARTMENT.head.agent, 'revenue-guardian');
  assert.equal(SALES_DEPARTMENT.head.reports_to, 'chief-of-staff');
  assert.deepEqual(SALES_DEPARTMENT.teams.map((team) => team.name), [
    'Prospect Supply', 'Outreach Conversation', 'Conversion & Handoff',
  ]);
  const members = SALES_DEPARTMENT.teams.flatMap((team) => team.members);
  for (const required of ['prospecting', 'enrichment', 'scoring', 'outreach', 'auto-outreach', 'drip-campaign', 'reply-classification', 'sales-nurture']) {
    assert.ok(members.includes(required), `missing department worker ${required}`);
  }
  assert.equal(SALES_DEPARTMENT.report_contract.recipient, 'chief-of-staff');
});

test('department health cannot be green when campaign, replies, or delivery safety is unproven', () => {
  const report = buildSalesDepartmentReport({
    asOf: '2026-09-10T16:00:00.000Z', reportingDate: '2026-09-10',
    target: 25, sentToday: 0, expected: 12,
    inventory: { prospects: 1900, withEmail: 800, scored: 300, sendReady: 20 },
    campaignReady: false, replySyncFresh: false, deliverabilityPaused: true,
    anomalies: [], blockers: {},
  });
  assert.equal(report.health, 'unhealthy');
  assert.ok(report.reasons.includes('canonical_campaign_not_active'));
  assert.ok(report.reasons.includes('reply_sync_not_fresh'));
  assert.equal(report.contains_contact_data, false);
});

test('department report covers the whole outcome ladder, not sends alone', () => {
  const report = buildSalesDepartmentReport({
    asOf: '2026-09-10T16:00:00.000Z', reportingDate: '2026-09-10',
    target: 25, sentToday: 25, expected: 25,
    inventory: { prospects: 1900, withEmail: 800, scored: 500, sendReady: 25 },
    outcomes30d: { provider_accepted: 100, delivered: 96, human_reply: 4, warm_reply: 2, demo_booked: 1 },
    campaignReady: true, replySyncFresh: true, deliverabilityPaused: false,
    anomalies: [], blockers: {},
  });
  assert.equal(report.health, 'healthy');
  assert.equal(report.outcomes_30d.human_reply, 4);
  assert.equal(report.outcomes_30d.warm_reply, 2);
  assert.equal(report.outcomes_30d.demo_booked, 1);
  assert.equal(report.outcomes_30d.won, 0);
  assert.equal(report.conversion_30d.delivery_rate, 96);
  assert.equal(report.conversion_30d.human_reply_rate, 4.2);
  assert.equal(report.conversion_30d.warm_reply_rate, 50);
  assert.equal(report.conversion_30d.demo_booked_rate, null, 'owner acceptance is a required denominator');
});
