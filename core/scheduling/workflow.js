'use strict';

const crypto = require('node:crypto');

const TRANSITIONS = Object.freeze({
  needed: new Set(['invitation_ready', 'cancelled', 'failed']),
  invitation_ready: new Set(['invited', 'cancelled', 'failed']),
  invited: new Set(['scheduled', 'cancelled', 'failed']),
  scheduled: new Set(['prepared', 'cancelled', 'reschedule_needed', 'failed']),
  prepared: new Set(['completed', 'no_show', 'cancelled', 'reschedule_needed', 'failed']),
  reschedule_needed: new Set(['invitation_ready', 'scheduled', 'cancelled', 'failed']),
  completed: new Set([]),
  no_show: new Set(['reschedule_needed', 'cancelled']),
  cancelled: new Set([]),
  failed: new Set(['needed', 'cancelled']),
});

function canTransition(from, to) {
  return Boolean(TRANSITIONS[from]?.has(to));
}

function validateScheduledWindow({ start, end, now = new Date(), policy }) {
  const errors = [];
  const startAt = new Date(start);
  const endAt = new Date(end);
  if (!Number.isFinite(startAt.getTime()) || !Number.isFinite(endAt.getTime())) {
    return { valid: false, errors: ['invalid_time'] };
  }
  if (endAt <= startAt) errors.push('invalid_duration');

  const notice = Number(policy?.minimum_notice_minutes ?? 120);
  if (!Number.isInteger(notice) || notice < 0) errors.push('invalid_minimum_notice');
  if (startAt.getTime() < now.getTime() + notice * 60_000) {
    errors.push('insufficient_notice');
  }

  const maximumDays = Number(policy?.maximum_days_ahead ?? 45);
  if (!Number.isInteger(maximumDays) || maximumDays < 1 || maximumDays > 365) {
    errors.push('invalid_maximum_days_ahead');
  }
  if (startAt.getTime() > now.getTime() + maximumDays * 24 * 60 * 60_000) {
    errors.push('too_far_ahead');
  }
  return { valid: errors.length === 0, errors };
}

function appointmentIdempotencyKey({ tenantId, appointmentType, sourceType, sourceId }) {
  if (!tenantId || !appointmentType || !sourceType || !sourceId) {
    throw new Error('tenantId, appointmentType, sourceType, and sourceId are required');
  }
  const canonical = [tenantId, appointmentType, sourceType, sourceId]
    .map(value => String(value).trim().toLowerCase());
  const digest = crypto
    .createHash('sha256')
    .update(JSON.stringify(canonical))
    .digest('hex');
  return `appointment:v1:${digest}`;
}

function hasFixedAvailabilityWindows(policy) {
  const windows = policy?.availability_rules?.windows;
  return Array.isArray(windows)
    && windows.length > 0
    && windows.every(window => (
      window
      && Array.isArray(window.days)
      && window.days.length > 0
      && /^\d{2}:\d{2}$/.test(String(window.start || ''))
      && /^\d{2}:\d{2}$/.test(String(window.end || ''))
      && window.start < window.end
    ));
}

/**
 * FGA owns the booking ledger and evaluates an explicit fixed-availability
 * policy. It never reads or writes Patrick's work calendar.
 */
function activationReadiness({
  policy,
  bookingSurfaceEnabled,
  fixedAvailabilityApproved,
  telnyxConfigured,
}) {
  const missing = [];
  if (!policy?.active) missing.push('active_policy');
  if (!policy?.timezone) missing.push('timezone');
  if (policy?.provider !== 'fga_fixed_availability') {
    missing.push('fga_booking_provider');
  }
  if (!hasFixedAvailabilityWindows(policy)) {
    missing.push('fixed_availability_windows');
  }
  if (bookingSurfaceEnabled !== true) missing.push('booking_surface');
  if (fixedAvailabilityApproved !== true) missing.push('fixed_availability_approval');
  if (telnyxConfigured !== true) missing.push('telnyx_messaging_identity');
  return {
    ready: missing.length === 0,
    missing,
    mode: missing.length === 0 ? 'supervised' : 'disabled',
  };
}

module.exports = {
  TRANSITIONS,
  activationReadiness,
  appointmentIdempotencyKey,
  canTransition,
  hasFixedAvailabilityWindows,
  validateScheduledWindow,
};
