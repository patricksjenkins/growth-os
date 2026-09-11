'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { FGA_TENANT_ID } = require('../../core/config');
const {
  classifyContinuityCandidate,
  providerFirstTouch,
  dailyRecoveryBudget,
  etDateKey,
} = require('../../worker/agents/sequence-recovery')._test;

const lead = {
  id: 'lead-a',
  lead_source: 'prospecting_agent',
  status: 'contacted',
  lifecycle_stage: 'sequenced',
  automation_status: 'auto_sent',
  email: 'prospect@example.com',
  employee_count_actual: 5,
  lead_score: 80,
  outreach_ready: true,
  metadata: {},
};

function classify(overrides = {}) {
  return classifyContinuityCandidate({
    tenantId: FGA_TENANT_ID,
    lead,
    providerAcceptedFirstTouch: { at: '2026-08-01T14:00:00.000Z' },
    ...overrides,
  });
}

test('provider-proven FGA prospect without an active sequence is recoverable', () => {
  const result = classify();
  assert.equal(result.eligible, true);
  assert.equal(result.reason, 'provider_proven_contact_needs_current_sequence');
});

test('customer, suppression, negative delivery, reply, and tenant boundaries all fail closed', () => {
  assert.equal(classify({ tenantId: 'client-tenant' }).reason, 'wrong_tenant');
  assert.equal(classify({ protectedCustomer: true }).reason, 'protected_customer');
  assert.equal(classify({ suppressed: true }).reason, 'suppressed');
  assert.equal(classify({ negativeDelivery: true }).reason, 'negative_delivery');
  assert.equal(classify({ humanReply: true }).reason, 'human_reply');
  assert.equal(classify({ hasOpenEnrollment: true }).reason, 'already_enrolled');
});

test('a sent label without immutable provider identity is not recovery authority', () => {
  assert.equal(providerFirstTouch({
    sequence_status: 'sent',
    metadata: { sent_at: '2026-08-01T14:00:00.000Z' },
  }), null);
  assert.equal(classify({ providerAcceptedFirstTouch: null }).reason, 'first_touch_not_provider_proven');
});

test('only eligible, scored 1-19 employee outbound prospects can recover', () => {
  assert.equal(classify({ lead: { ...lead, employee_count_actual: 20 } }).reason, 'employee_fit_excluded');
  assert.equal(classify({ lead: { ...lead, employee_count_actual: null, size: null } }).reason, 'employee_evidence_missing');
  assert.equal(classify({ lead: { ...lead, lead_source: 'website_demo_request' } }).reason, 'not_outbound_prospect');
  assert.equal(classify({ lead: { ...lead, outreach_ready: false } }).reason, 'below_quality_threshold');
});

test('the provider receipt parser requires both provider id and timestamp', () => {
  assert.deepEqual(providerFirstTouch({
    sequence_status: 'sent',
    metadata: { delivered: { provider_id: 'provider-a', at: '2026-08-01T14:00:00Z' } },
  }), { at: '2026-08-01T14:00:00.000Z' });
  assert.equal(providerFirstTouch({
    sequence_status: 'sent', metadata: { delivered: { provider_id: 'provider-a' } },
  }), null);
});

test('the five-per-day recovery cap survives retries and manual reruns', () => {
  const now = new Date('2026-09-11T16:00:00.000Z');
  const rows = [
    ...Array.from({ length: 4 }, (_, index) => ({
      id: `today-${index}`,
      enrolled_by: 'sequence-recovery',
      created_at: `2026-09-11T1${index}:00:00.000Z`,
    })),
    { id: 'other-agent', enrolled_by: 'outreach', created_at: '2026-09-11T15:00:00.000Z' },
    { id: 'yesterday', enrolled_by: 'sequence-recovery', created_at: '2026-09-10T15:00:00.000Z' },
  ];
  assert.deepEqual(dailyRecoveryBudget(rows, { limit: 5, now }), {
    daily_limit: 5,
    recovered_today: 4,
    remaining: 1,
  });
  rows.push({ id: 'fifth', enrolled_by: 'sequence-recovery', created_at: '2026-09-11T15:30:00.000Z' });
  assert.equal(dailyRecoveryBudget(rows, { limit: 5, now }).remaining, 0);
});

test('recovery day boundaries follow Eastern time rather than UTC midnight', () => {
  assert.equal(etDateKey('2026-09-11T03:30:00.000Z'), '2026-09-10');
  assert.equal(etDateKey('2026-09-11T04:30:00.000Z'), '2026-09-11');
});

test('the recovery agent is scheduled, registered, FGA-gated, and cannot dispatch', () => {
  const source = fs.readFileSync(require.resolve('../../worker/agents/sequence-recovery'), 'utf8');
  const scheduler = fs.readFileSync(require.resolve('../../worker/scheduler/cron'), 'utf8');
  const server = fs.readFileSync(require.resolve('../../api/server'), 'utf8');
  assert.match(source, /tenant\?\.id !== FGA_TENANT_ID/);
  assert.match(source, /sequence_recovery_enabled/);
  assert.match(source, /suppressedDomains\.has\(domain\)/);
  assert.match(source, /suppressedCompanies\.has\(companyName\)/);
  assert.match(source, /if \(payload\.dry_run\)/);
  assert.match(source, /dailyRecoveryBudget\(enrollments/);
  assert.doesNotMatch(source, /sendEmail|sendEmailOutreachSequence|integrations\/email/);
  assert.match(scheduler, /agent: 'sequence-recovery'.*when: \(t\) => isFGAlike\(t\)/);
  assert.match(server, /\['sequence-recovery', '\.\.\/worker\/agents\/sequence-recovery'\]/);
});
