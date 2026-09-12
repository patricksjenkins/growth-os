'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { FGA_TENANT_ID } = require('../../core/config');
const outreach = require('../../worker/agents/outreach');
const {
  getSchedule,
  _test: {
    hasRecentSpeedToLeadCandidates,
    hasUnclassifiedInboundReplies,
    fgaHasDueDripWork,
    hasDueScheduledEmails,
    hasPendingPushNotifications,
    hasPendingNonPushNotifications,
  },
} = require('../../worker/scheduler/cron');

function countClient(responses = {}) {
  const offsets = new Map();
  return {
    from(table) {
      const list = Array.isArray(responses[table]) ? responses[table] : [responses[table] ?? 0];
      const index = offsets.get(table) || 0;
      offsets.set(table, index + 1);
      const value = list[Math.min(index, list.length - 1)];
      const result = typeof value === 'object'
        ? { count: value.count ?? 0, error: value.error || null }
        : { count: value, error: null };
      const builder = {};
      for (const method of ['select', 'eq', 'not', 'is', 'gte', 'lte', 'or']) {
        builder[method] = () => builder;
      }
      builder.then = (resolve) => resolve(result);
      return builder;
    },
  };
}

test('autonomous exact-FGA draft handoffs are demand-bound while owner and customer work remain available', () => {
  assert.equal(outreach.isAutonomousFgaSupply(FGA_TENANT_ID, 'email_only', {}), true);
  assert.equal(outreach.isAutonomousFgaSupply(FGA_TENANT_ID, 'email_only', {
    lead_id: 'lead-1', skip_send_handoff: true,
  }), true);
  assert.equal(outreach.isAutonomousFgaSupply(FGA_TENANT_ID, 'email_only', {
    lead_id: 'lead-1', restart_batch_id: 'batch-1',
  }), true);
  assert.equal(outreach.isAutonomousFgaSupply(FGA_TENANT_ID, 'email_only', {
    lead_id: 'lead-1',
  }), false, 'an explicit owner-created single-lead draft is not speculative supply');
  assert.equal(outreach.isAutonomousFgaSupply('customer-tenant', 'email_only', {}), false);
});

test('queue-presence predicates enqueue workers only when useful work exists and fail closed', async () => {
  const tenant = { id: FGA_TENANT_ID };
  assert.equal(await hasRecentSpeedToLeadCandidates(tenant, countClient({ leads: 0 })), false);
  assert.equal(await hasRecentSpeedToLeadCandidates(tenant, countClient({ leads: 1 })), true);
  assert.equal(await hasUnclassifiedInboundReplies(tenant, countClient({ conversations: 0 })), false);
  assert.equal(await hasUnclassifiedInboundReplies(tenant, countClient({ conversations: 2 })), true);
  assert.equal(await hasDueScheduledEmails(tenant, countClient({ scheduled_emails: 1 })), true);
  assert.equal(await hasPendingPushNotifications(tenant, countClient({ notifications: 0 })), false);
  assert.equal(await hasPendingNonPushNotifications(tenant, countClient({ notifications: 1 })), true);
  assert.equal(await hasDueScheduledEmails(tenant, countClient({
    scheduled_emails: { error: { message: 'unavailable' } },
  })), false);
});

test('drip dispatch polling is exact-FGA and sleeps until a follow-up or resume is due', async () => {
  assert.equal(await fgaHasDueDripWork({ id: 'customer-tenant' }, countClient()), false);
  assert.equal(await fgaHasDueDripWork({ id: FGA_TENANT_ID }, countClient({
    drip_enrollments: [0, 0],
  })), false);
  assert.equal(await fgaHasDueDripWork({ id: FGA_TENANT_ID }, countClient({
    drip_enrollments: [1, 0],
  })), true);
  assert.equal(await fgaHasDueDripWork({ id: FGA_TENANT_ID }, countClient({
    drip_enrollments: [0, 1],
  })), true);
});

test('high-frequency schedules retain coverage but stop writing empty jobs', () => {
  const schedule = getSchedule();
  const replySync = schedule.find((row) => row.agent === 'drip-campaign' && row.payload?.task === 'sync_replies');
  const dripSend = schedule.find((row) => row.agent === 'drip-campaign' && !row.payload);
  const ownerHandoff = schedule.find((row) => row.agent === 'owner-handoff');
  const monitor = schedule.find((row) => row.agent === 'system-monitor');
  assert.equal(replySync.cron, '15 8,10,12,14,16,18 * * *');
  assert.equal(dripSend.when, fgaHasDueDripWork);
  assert.equal(ownerHandoff.cron, '25 9,18 * * *');
  assert.equal(monitor.cron, '0 */6 * * *');
  for (const agent of ['speed-to-lead', 'reply-classification', 'scheduled-email-dispatch', 'notification-push', 'notifications']) {
    assert.equal(typeof schedule.find((row) => row.agent === agent).when, 'function', `${agent} must be idle-by-default`);
  }
});

test('exact-FGA paid generation is attributed and bounded to one request per logical attempt', () => {
  const root = path.join(__dirname, '..', '..');
  const sources = ['outreach.js', 'enrichment.js', 'prospecting.js']
    .map((name) => fs.readFileSync(path.join(root, 'worker', 'agents', name), 'utf8'));
  assert.match(sources[0], /operationType: 'outreach_draft'[\s\S]*retries: 0,[\s\S]*providerAttempts: 1/);
  assert.match(sources[1], /operationType: 'enrichment_extract'[\s\S]*retries: 0,[\s\S]*providerAttempts: 1/);
  assert.match(sources[2], /operationType: 'prospecting_extract'[\s\S]*providerAttempts: 1/);
  for (const source of sources) {
    assert.match(source, /tenant,/);
    assert.match(source, /requestSource: 'worker\/agents\//);
  }
});
