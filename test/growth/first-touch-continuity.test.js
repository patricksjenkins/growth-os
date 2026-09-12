'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { FGA_TENANT_ID } = require('../../core/config');
const { createProtectedOrganizationIndex } = require('../../core/growth/customer-boundary');
const {
  REPAIR_TASK,
  enrollmentState,
  withContinuity,
  persistContinuity,
  enqueueContinuityRepair,
} = require('../../core/revenue/first-touch-continuity');
const { reconcileFirstTouch } = require('../../worker/agents/sequence-recovery')._test;
const { sevenTouchReadiness } = require('../../worker/agents/auto-outreach');

function fakeDb(handler) {
  return {
    from(table) {
      const state = { table, op: 'select', row: null, filters: [] };
      const builder = {
        select() { return builder; },
        update(row) { state.op = 'update'; state.row = row; return builder; },
        insert(row) { state.op = 'insert'; state.row = row; return builder; },
        eq(column, value) { state.filters.push(['eq', column, value]); return builder; },
        in(column, value) { state.filters.push(['in', column, value]); return builder; },
        contains(column, value) { state.filters.push(['contains', column, value]); return builder; },
        limit() { return builder; },
        single() { return builder; },
        maybeSingle() { return builder; },
        then(resolve, reject) {
          try { return Promise.resolve(handler(state)).then(resolve, reject); }
          catch (error) { return reject(error); }
        },
      };
      return builder;
    },
  };
}

test('enrollment results distinguish proven continuity, terminal suppression, and repair work', () => {
  assert.deepEqual(enrollmentState({ enrolled: true, enrollment: { id: 'enrollment-a' } }), {
    status: 'enrolled', enrollment_id: 'enrollment-a', reason: null,
  });
  assert.equal(enrollmentState({ skipped_reason: 'already_enrolled' }).status, 'pending_reconciliation');
  assert.equal(enrollmentState({ skipped_reason: 'suppressed:provider_suppression' }).status, 'terminal_suppressed');
  assert.equal(enrollmentState({ skipped_reason: 'error:database unavailable' }).status, 'pending_reconciliation');
});

test('the autonomous sender requires the active canonical seven-touch contract', () => {
  const disabled = { config: { drip_campaign_enabled: 'false' } };
  const enabled = { config: { drip_campaign_enabled: 'true' } };
  assert.deepEqual(sevenTouchReadiness(disabled), {
    ready: false, reason: 'seven_touch_disabled',
  });
  assert.deepEqual(sevenTouchReadiness(enabled, { id: 'legacy', plan_key: 'old-plan' }), {
    ready: false, reason: 'seven_touch_campaign_not_active',
  });
  assert.equal(sevenTouchReadiness(enabled, {
    id: 'campaign-a', plan_key: 'database-first-seven-touch-v2',
  }).ready, true);
});

test('the delivered snapshot survives continuity state changes', () => {
  const metadata = withContinuity({
    delivered: { provider_id: 'provider-a', at: '2026-09-12T13:20:00.000Z' },
  }, { status: 'enrolled', enrollment_id: 'enrollment-a' }, '2026-09-12T13:20:01.000Z');
  assert.equal(metadata.delivered.provider_id, 'provider-a');
  assert.equal(metadata.seven_touch_continuity.status, 'enrolled');
  assert.equal(metadata.seven_touch_continuity.enrollment_id, 'enrollment-a');
});

test('continuity state writes are exact-FGA and require an already-sent sequence', async () => {
  let write;
  const db = fakeDb((state) => {
    write = state;
    return { data: { id: 'sequence-a' }, error: null };
  });
  await persistContinuity(db, {
    sequenceId: 'sequence-a',
    metadata: { delivered: { provider_id: 'provider-a' } },
    state: { status: 'enrolled', enrollment_id: 'enrollment-a' },
    at: '2026-09-12T13:20:01.000Z',
  });
  assert.deepEqual(write.filters, [
    ['eq', 'tenant_id', FGA_TENANT_ID],
    ['eq', 'id', 'sequence-a'],
    ['eq', 'sequence_status', 'sent'],
  ]);
  assert.equal(write.row.metadata.delivered.provider_id, 'provider-a');
});

test('a pending continuity repair is queued once with no provider payload', async () => {
  const writes = [];
  const db = fakeDb((state) => {
    if (state.op === 'select') return { data: [], error: null };
    writes.push(state);
    return { data: { id: 'job-a' }, error: null };
  });
  const result = await enqueueContinuityRepair(db, { leadId: 'lead-a', sequenceId: 'sequence-a' });
  assert.equal(result.queued, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].row.tenant_id, FGA_TENANT_ID);
  assert.equal(writes[0].row.agent_name, 'sequence-recovery');
  assert.deepEqual(writes[0].row.payload, {
    task: REPAIR_TASK, lead_id: 'lead-a', sequence_id: 'sequence-a',
  });
});

test('targeted reconciliation enrolls from the immutable provider time and never sends', async () => {
  const providerAt = '2026-09-12T13:20:00.000Z';
  const sequence = {
    id: 'sequence-a',
    lead_id: 'lead-a',
    sequence_status: 'sent',
    metadata: {
      delivered: {
        provider_id: 'provider-a',
        recipient: 'prospect@example.com',
        at: providerAt,
      },
    },
  };
  const lead = {
    id: 'lead-a', company_name: 'Small Co', domain: 'example.com', email: null,
    lead_source: 'prospecting_agent', status: 'contacted', lifecycle_stage: 'sequenced',
    automation_status: 'auto_sent', employee_count_actual: 6, size: null,
    lead_score: 82, outreach_ready: true, metadata: {}, created_at: '2026-01-01T00:00:00Z',
  };
  const db = fakeDb((state) => {
    if (state.table === 'outreach_sequences') return { data: sequence, error: null };
    if (state.table === 'leads') return { data: lead, error: null };
    if (state.table === 'drip_enrollments') return { data: null, error: null };
    if (state.table === 'drip_inbound' || state.table === 'email_events') return { data: [], error: null };
    throw new Error(`unexpected query ${state.table}:${state.op}`);
  });
  let enrollmentInput;
  let continuityWrite;
  const result = await reconcileFirstTouch(
    db,
    { id: FGA_TENANT_ID, slug: 'fga' },
    { task: REPAIR_TASK, lead_id: 'lead-a', sequence_id: 'sequence-a' },
    { id: 'campaign-a' },
    { success() {} },
    {
      loadProtectedOrganizationIndex: async () => createProtectedOrganizationIndex(),
      isSuppressed: async () => null,
      enrollLead: async (_db, input) => {
        enrollmentInput = input;
        return { enrolled: true, enrollment: { id: 'enrollment-a' } };
      },
      persistContinuity: async (_db, input) => { continuityWrite = input; },
      linkRestartEnrollment: async () => ({ applicable: false, linked: false }),
    },
  );
  assert.equal(result.success, true);
  assert.equal(result.repaired, true);
  assert.equal(result.sends_messages, false);
  assert.equal(enrollmentInput.day1At, providerAt, 'bookkeeping delay must not move the seven-touch clock');
  assert.equal(enrollmentInput.email, 'prospect@example.com', 'immutable delivered recipient repairs a missing lead email');
  assert.equal(continuityWrite.state.enrollment_id, 'enrollment-a');
  const source = fs.readFileSync(require.resolve('../../worker/agents/sequence-recovery'), 'utf8');
  assert.doesNotMatch(source, /sendEmail|sendEmailOutreachSequence|integrations\/email/);
});

test('targeted continuity refuses a customer tenant before reading or writing', async () => {
  let touched = false;
  const db = { from() { touched = true; throw new Error('must not query'); } };
  const result = await reconcileFirstTouch(
    db,
    { id: 'customer-tenant', slug: 'customer' },
    { task: REPAIR_TASK, lead_id: 'lead-a', sequence_id: 'sequence-a' },
    { id: 'campaign-a' },
    { success() {} },
  );
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'not_fga_tenant');
  assert.equal(result.sends_messages, false);
  assert.equal(touched, false);
});
