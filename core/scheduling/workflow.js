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

function activationReadiness({ policy, providerConfigured, calendarAuthorized }) {
  const missing = [];
  if (!policy?.active) missing.push('active_policy');
  if (!policy?.timezone) missing.push('timezone');
  if (!policy?.provider) missing.push('provider');
  if (!policy?.availability_rules || Object.keys(policy.availability_rules).length === 0) {
    missing.push('availability_rules');
  }
  if (!providerConfigured) missing.push('provider_configuration');
  if (!calendarAuthorized) missing.push('calendar_authorization');
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
  validateScheduledWindow,
};
