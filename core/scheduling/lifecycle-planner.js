'use strict';

const crypto = require('node:crypto');

const AUTOMATION_MODES = Object.freeze(new Set(['shadow', 'supervised']));
const TERMINAL_BOOKING_STATES = Object.freeze(new Set(['cancelled', 'no_show']));

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, canonicalize(value[key])])
    );
  }
  return value;
}

function digest(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}

function parseTime(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function commandEnvelope({
  tenantId,
  appointmentId,
  action,
  expectedRevision,
  evidence,
  nextReminderAt = null,
  exceptionCode = null,
}) {
  if (!tenantId || !appointmentId || !action) {
    throw new Error('tenantId, appointmentId, and action are required');
  }
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw new Error('expectedRevision must be a non-negative integer');
  }
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw new Error('evidence must be an object');
  }

  const semantic = {
    tenantId: String(tenantId),
    appointmentId: String(appointmentId),
    action: String(action),
    expectedRevision,
    evidence: canonicalize(evidence),
    nextReminderAt,
    exceptionCode,
  };
  const requestFingerprint = digest(semantic);
  return Object.freeze({
    ...semantic,
    idempotencyKey: `appointment-lifecycle:v1:${requestFingerprint}`,
    requestFingerprint,
  });
}

function blocked(reason, details = []) {
  return { decision: 'blocked', reason, details };
}

function command(input, action, evidence, options = {}) {
  return {
    decision: 'command',
    command: commandEnvelope({
      tenantId: input.tenantId,
      appointmentId: input.appointment.id,
      action,
      expectedRevision: Number(input.lifecycle?.revision ?? 0),
      evidence,
      nextReminderAt: options.nextReminderAt || null,
      exceptionCode: options.exceptionCode || null,
    }),
  };
}

/**
 * Produce at most one database command. This planner has no provider client and
 * cannot send invitations, reminders, or follow-ups.
 */
function planSchedulingLifecycle(input) {
  const now = parseTime(input?.now);
  const appointment = input?.appointment;
  const lifecycle = input?.lifecycle || {};
  const control = input?.control;
  const receipts = input?.receipts || {};

  if (!now) return blocked('invalid_clock');
  if (!input?.tenantId || !appointment?.id) return blocked('identity_required');
  if (appointment.tenant_id !== input.tenantId) return blocked('tenant_mismatch');
  if (lifecycle.tenant_id && lifecycle.tenant_id !== input.tenantId) {
    return blocked('lifecycle_tenant_mismatch');
  }
  if (!control || control.tenant_id !== input.tenantId) {
    return blocked('tenant_control_missing');
  }
  if (control.enabled !== true) return blocked('automation_disabled');
  if (control.kill_switch_engaged !== false) return blocked('kill_switch_engaged');
  if (!AUTOMATION_MODES.has(control.execution_mode)) {
    return blocked('execution_mode_disabled');
  }
  if (control.provider_dispatch_enabled === true) {
    return blocked('planner_cannot_dispatch');
  }
  if (
    TERMINAL_BOOKING_STATES.has(appointment.status)
    && !receipts.providerCancellation?.id
  ) {
    return { decision: 'noop', reason: 'terminal_booking_state' };
  }
  if (lifecycle.lifecycle_state === 'exception') {
    return blocked('exception_requires_resolution');
  }

  const observedAt = now.toISOString();
  const evidence = (sourceType, sourceId, extra = {}) => ({
    source_type: sourceType,
    source_id: String(sourceId),
    observed_at: observedAt,
    ...extra,
  });

  // State-changing provider facts always outrank clock-based recommendations.
  if (receipts.providerCancellation?.id) {
    if (!['invited', 'scheduled', 'prepared', 'no_show', 'cancelled'].includes(
      appointment.status
    )) {
      return blocked('cancellation_receipt_state_mismatch');
    }
    return command(
      input,
      'mark_reschedule_needed',
      evidence('provider_receipt', receipts.providerCancellation.id)
    );
  }
  if (
    appointment.status === 'invitation_ready'
    && receipts.invitationDelivered?.id
  ) {
    return command(
      input,
      'record_invitation_delivery',
      evidence('provider_receipt', receipts.invitationDelivered.id)
    );
  }
  if (appointment.status === 'scheduled' && lifecycle.lifecycle_state !== 'scheduled') {
    if (!receipts.booking?.id) return blocked('booking_receipt_required');
    const minutesBefore = Number(
      input.policy?.reminder_policy?.minutes_before?.[0]
    );
    const scheduledStart = parseTime(appointment.scheduled_start);
    const nextReminderAt = scheduledStart
      && Number.isInteger(minutesBefore)
      && minutesBefore > 0
      ? new Date(scheduledStart.getTime() - minutesBefore * 60_000).toISOString()
      : null;
    return command(
      input,
      'synchronize_booking',
      evidence('provider_receipt', receipts.booking.id),
      { nextReminderAt }
    );
  }
  if (lifecycle.lifecycle_state === 'reminder_due' && receipts.reminderDelivered?.id) {
    return command(
      input,
      'record_reminder_delivery',
      evidence('provider_receipt', receipts.reminderDelivered.id)
    );
  }
  if (appointment.status === 'scheduled' && receipts.preparation?.id) {
    return command(
      input,
      'mark_prepared',
      evidence('document_receipt', receipts.preparation.id)
    );
  }
  if (appointment.status === 'prepared' && receipts.completion?.id) {
    return command(
      input,
      'mark_completed',
      evidence('completion_receipt', receipts.completion.id)
    );
  }
  if (
    lifecycle.lifecycle_state === 'follow_up_due'
    && receipts.followUpDelivered?.id
  ) {
    return command(
      input,
      'mark_follow_up_complete',
      evidence('provider_receipt', receipts.followUpDelivered.id)
    );
  }

  if (appointment.status === 'needed') {
    const missing = [];
    if (input.policy?.active !== true) missing.push('active_policy');
    if (!input.policy?.provider) missing.push('provider');
    if (!input.policy?.timezone) missing.push('timezone');
    if (!input.policy?.availability_rules
      || Object.keys(input.policy.availability_rules).length === 0) {
      missing.push('availability_rules');
    }
    if (input.providerConfigured !== true) missing.push('provider_configuration');
    if (input.calendarAuthorized !== true) missing.push('calendar_authorization');
    if (missing.length) return blocked('invitation_not_ready', missing);
    return command(
      input,
      'mark_invitation_ready',
      evidence('policy_evaluation', `policy:${input.policy.id || 'default'}`)
    );
  }
  if (appointment.status === 'invitation_ready') {
    return blocked('invitation_delivery_receipt_required');
  }

  const reminderDueAt = parseTime(lifecycle.next_reminder_at);
  if (
    ['invited', 'scheduled', 'prepared'].includes(appointment.status)
    && reminderDueAt
    && reminderDueAt <= now
    && lifecycle.lifecycle_state !== 'reminder_due'
  ) {
    return command(
      input,
      'mark_reminder_due',
      evidence('system_clock', `reminder:${reminderDueAt.toISOString()}`, {
        due_at: reminderDueAt.toISOString(),
      })
    );
  }

  const followUpDueAt = parseTime(appointment.follow_up_due_at);
  if (
    appointment.status === 'completed'
    && followUpDueAt
    && followUpDueAt <= now
    && !['follow_up_due', 'follow_up_completed'].includes(lifecycle.lifecycle_state)
  ) {
    return command(
      input,
      'mark_follow_up_due',
      evidence('system_clock', `follow-up:${followUpDueAt.toISOString()}`, {
        due_at: followUpDueAt.toISOString(),
      })
    );
  }

  const scheduledEnd = parseTime(appointment.scheduled_end);
  if (
    ['scheduled', 'prepared'].includes(appointment.status)
    && scheduledEnd
    && scheduledEnd < now
  ) {
    return command(
      input,
      'raise_exception',
      evidence('system_clock', `elapsed-window:${scheduledEnd.toISOString()}`),
      { exceptionCode: 'appointment_window_elapsed_unresolved' }
    );
  }

  return { decision: 'noop', reason: 'no_authoritative_transition_due' };
}

module.exports = {
  AUTOMATION_MODES,
  commandEnvelope,
  planSchedulingLifecycle,
};
