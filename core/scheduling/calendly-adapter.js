'use strict';

const crypto = require('node:crypto');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CALENDLY_EVENT_RE = /^https:\/\/api\.calendly\.com\/scheduled_events\/[A-Za-z0-9_-]{6,200}$/;
const EVENT_TYPES = new Set(['invitee.created', 'invitee.canceled']);

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, stableValue(value[key])])
  );
}

function fingerprint(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(stableValue(value)))
    .digest('hex');
}

function validDate(value) {
  return typeof value === 'string' && Number.isFinite(new Date(value).getTime());
}

/**
 * Normalize only the non-PII scheduling receipt required by the canonical
 * workflow. Invitee names, email addresses, answers, and raw payloads never
 * enter this contract.
 */
function normalizeCalendlyEvent({
  tenantId,
  eventType,
  payload,
  leadId = null,
  appointmentType = 'discovery',
} = {}) {
  const errors = [];
  if (!UUID_RE.test(String(tenantId || ''))) errors.push('tenant_id_invalid');
  if (!EVENT_TYPES.has(eventType)) errors.push('event_type_unsupported');
  if (leadId != null && !UUID_RE.test(String(leadId))) errors.push('lead_id_invalid');

  const scheduledEvent = payload?.event || {};
  const providerEventId = scheduledEvent.uri || payload?.uri;
  if (typeof providerEventId !== 'string' || !CALENDLY_EVENT_RE.test(providerEventId.trim())) {
    errors.push('provider_event_id_invalid');
  }

  const normalizedType = eventType === 'invitee.created' ? 'booked' : 'cancelled';
  let start = null;
  let end = null;
  if (normalizedType === 'booked') {
    start = scheduledEvent.start_time;
    end = scheduledEvent.end_time;
    if (!validDate(start)) errors.push('scheduled_start_invalid');
    if (!validDate(end)) {
      const duration = Number(scheduledEvent.duration);
      if (validDate(start) && Number.isFinite(duration) && duration > 0) {
        end = new Date(new Date(start).getTime() + duration * 60_000).toISOString();
      } else {
        errors.push('scheduled_end_invalid');
      }
    }
    if (validDate(start) && validDate(end) && new Date(end) <= new Date(start)) {
      errors.push('scheduled_window_invalid');
    }
  }

  if (errors.length) return { ok: false, errors };

  const event = {
    tenant_id: String(tenantId).toLowerCase(),
    provider: 'calendly',
    provider_event_id: providerEventId.trim(),
    event_type: normalizedType,
    appointment_type: String(appointmentType || 'discovery').trim().toLowerCase(),
    lead_id: leadId ? String(leadId).toLowerCase() : null,
    scheduled_start: start ? new Date(start).toISOString() : null,
    scheduled_end: end ? new Date(end).toISOString() : null,
  };
  const requestFingerprint = fingerprint(event);
  return {
    ok: true,
    event,
    request_fingerprint: requestFingerprint,
    idempotency_key: `calendly:${normalizedType}:${fingerprint({
      tenant_id: event.tenant_id,
      provider_event_id: event.provider_event_id,
    })}`,
  };
}

function activationReadiness({
  schedulingFlag,
  tenantInCohort,
  policy,
  integration,
  outboundIdentityReady,
} = {}) {
  const missing = [];
  if (schedulingFlag !== true) missing.push('scheduling_write_flag');
  if (tenantInCohort !== true) missing.push('exact_tenant_cohort');
  if (!policy?.active) missing.push('active_policy');
  if (policy?.provider !== 'calendly') missing.push('calendly_policy');
  if (!policy?.availability_rules || Object.keys(policy.availability_rules).length === 0) {
    missing.push('availability_rules');
  }
  if (integration?.active !== true) missing.push('active_calendly_integration');
  if (integration?.webhookVerified !== true) missing.push('calendly_webhook_verification');
  if (integration?.bookingUrlConfigured !== true) missing.push('calendly_booking_url');
  if (outboundIdentityReady !== true) missing.push('tenant_outbound_identity');
  return {
    ready: missing.length === 0,
    mode: missing.length === 0 ? 'supervised' : 'disabled',
    missing,
  };
}

module.exports = {
  CALENDLY_EVENT_RE,
  EVENT_TYPES,
  activationReadiness,
  normalizeCalendlyEvent,
};
