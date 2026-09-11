'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { planOwnerHandoff } = require('../worker/agents/owner-handoff');
const { SALES_DEPARTMENT } = require('../core/revenue/sales-department');

test('interested, question, and human-reply states route to distinct owner work', () => {
  assert.equal(planOwnerHandoff({ status: 'interested', metadata: {} }).action, 'sales_call');
  assert.equal(planOwnerHandoff({ status: 'new_lead', lifecycle_stage: 'engaged', metadata: {} }).action, 'answer_question');
  assert.equal(planOwnerHandoff({ status: 'replied', metadata: {} }).action, 'review_reply');
});

test('handoff is complete only when lead state and the durable owner action both exist', () => {
  const lead = {
    id: 'lead-1',
    status: 'interested', next_action_owner: 'owner', next_best_action: 'sales_call',
    handoff_at: '2026-09-11T12:00:00Z', metadata: {},
  };
  const missingAttention = planOwnerHandoff(lead);
  assert.equal(missingAttention.leadLooksRouted, true);
  assert.equal(missingAttention.hasOwnerAttention, false);
  assert.equal(missingAttention.alreadyRouted, false);

  const complete = planOwnerHandoff(lead, {
    ownerAttentionKeys: new Set(['sales_reply_interested:lead-1']),
  });
  assert.equal(complete.hasOwnerAttention, true);
  assert.equal(complete.alreadyRouted, true);
});

test('quarantined intake is excluded from owner handoff', () => {
  assert.equal(planOwnerHandoff({
    status: 'interested', metadata: { intake_safety: { contact_allowed: false } },
  }), null);
});

test('the department names a real registered worker with a 24-hour service contract', () => {
  const team = SALES_DEPARTMENT.teams.find((row) => row.name === 'Conversion & Handoff');
  assert.ok(team.members.includes('owner-handoff'));
  assert.equal(SALES_DEPARTMENT.service_contracts.owner_handoff.sla_hours, 24);
  const server = fs.readFileSync(path.join(__dirname, '..', 'api', 'server.js'), 'utf8');
  const cron = fs.readFileSync(path.join(__dirname, '..', 'worker', 'scheduler', 'cron.js'), 'utf8');
  assert.match(server, /\['owner-handoff', '\.\.\/worker\/agents\/owner-handoff'\]/);
  assert.match(cron, /agent: 'owner-handoff'/);
});

test('owner-handoff cannot send prospect communications or cross tenant boundaries', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'worker', 'agents', 'owner-handoff.js'), 'utf8');
  assert.doesNotMatch(source, /sendEmail|sendSms|sendMessage|integrations\/email|integrations\/telnyx/);
  assert.match(source, /\.eq\('tenant_id', FGA_TENANT_ID\)/);
  assert.match(source, /tenant\.id !== FGA_TENANT_ID/);
  assert.match(source, /fetchAllRows/);
  assert.doesNotMatch(source, /\.limit\(100\)/);
  assert.match(source, /isSyntheticGrowthLead/);
  assert.match(source, /ownerAttentionKeys/);
});
