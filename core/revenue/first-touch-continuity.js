'use strict';

/**
 * Durable bridge between a provider-accepted FGA first touch and its
 * seven-touch enrollment.
 *
 * Provider delivery cannot be rolled back. If the enrollment write that
 * follows it fails, the only safe response is to preserve the accepted send,
 * mark continuity as pending, and queue a database-only reconciliation job.
 * Nothing in this module can call an outbound provider.
 */

const { FGA_TENANT_ID } = require('../config');
const { PLAN_KEY } = require('../growth/seven-touch-plan');

const REPAIR_AGENT = 'sequence-recovery';
const REPAIR_TASK = 'reconcile_first_touch';
const CONTINUITY_KEY = 'seven_touch_continuity';

function enrollmentState(result = {}) {
  if (result.enrolled && result.enrollment?.id) {
    return {
      status: 'enrolled',
      enrollment_id: result.enrollment.id,
      reason: null,
    };
  }
  if (result.skipped_reason === 'already_enrolled' && result.enrollment?.id) {
    return {
      status: 'enrolled_existing',
      enrollment_id: result.enrollment?.id || null,
      reason: 'already_enrolled',
    };
  }
  if (result.skipped_reason === 'already_enrolled') {
    return {
      status: 'pending_reconciliation',
      enrollment_id: null,
      reason: 'already_enrolled_identity_unverified',
    };
  }
  if (String(result.skipped_reason || '').startsWith('suppressed:')) {
    return {
      status: 'terminal_suppressed',
      enrollment_id: null,
      reason: result.skipped_reason,
    };
  }
  return {
    status: 'pending_reconciliation',
    enrollment_id: null,
    reason: result.skipped_reason || 'enrollment_result_unverified',
  };
}

function withContinuity(metadata = {}, state = {}, at = new Date().toISOString()) {
  return {
    ...(metadata || {}),
    [CONTINUITY_KEY]: {
      status: state.status || 'pending_reconciliation',
      enrollment_id: state.enrollment_id || null,
      reason: state.reason || null,
      assessed_at: at,
      plan_key: PLAN_KEY,
    },
  };
}

async function persistContinuity(db, {
  sequenceId,
  metadata,
  state,
  at = new Date().toISOString(),
}) {
  const nextMetadata = withContinuity(metadata, state, at);
  const { data, error } = await db.from('outreach_sequences')
    .update({ metadata: nextMetadata, updated_at: at })
    .eq('tenant_id', FGA_TENANT_ID)
    .eq('id', sequenceId)
    .eq('sequence_status', 'sent')
    .select('id')
    .maybeSingle();
  if (error) throw new Error(`continuity_state_write_failed:${error.message}`);
  if (!data?.id) throw new Error('continuity_state_write_failed:sent sequence not updated');
  return nextMetadata;
}

/**
 * Queue one exact-sequence repair. The send choke point calls this only after
 * provider acceptance, so a repair job is evidence reconciliation—not a send.
 * Pending/processing duplicate jobs are reused rather than multiplied.
 */
async function enqueueContinuityRepair(db, { leadId, sequenceId }) {
  const payload = {
    task: REPAIR_TASK,
    lead_id: leadId,
    sequence_id: sequenceId,
  };
  const existing = await db.from('agent_jobs')
    .select('id')
    .eq('tenant_id', FGA_TENANT_ID)
    .eq('agent_name', REPAIR_AGENT)
    .in('status', ['pending', 'processing'])
    .contains('payload', payload)
    .limit(1);
  if (existing.error) throw new Error(`continuity_job_read_failed:${existing.error.message}`);
  if (existing.data?.length) {
    return { queued: false, existing: true, job_id: existing.data[0].id };
  }
  const inserted = await db.from('agent_jobs').insert({
    tenant_id: FGA_TENANT_ID,
    agent_name: REPAIR_AGENT,
    payload,
    status: 'pending',
    priority: 9,
  }).select('id').single();
  if (inserted.error || !inserted.data?.id) {
    throw new Error(`continuity_job_insert_failed:${inserted.error?.message || 'missing receipt'}`);
  }
  return { queued: true, existing: false, job_id: inserted.data.id };
}

async function linkRestartEnrollment(db, {
  restartBatchId,
  leadId,
  sequenceId,
  enrollmentId,
}) {
  if (!restartBatchId || !enrollmentId) return { applicable: false, linked: false };
  const result = await db.from('growth_restart_candidates')
    .update({ applied_enrollment_id: enrollmentId })
    .eq('tenant_id', FGA_TENANT_ID)
    .eq('batch_id', restartBatchId)
    .eq('lead_id', leadId)
    .eq('first_touch_sequence_id', sequenceId)
    .select('id')
    .maybeSingle();
  if (result.error) throw new Error(`restart_enrollment_link_failed:${result.error.message}`);
  return { applicable: true, linked: Boolean(result.data?.id) };
}

module.exports = {
  REPAIR_AGENT,
  REPAIR_TASK,
  CONTINUITY_KEY,
  enrollmentState,
  withContinuity,
  persistContinuity,
  enqueueContinuityRepair,
  linkRestartEnrollment,
};
