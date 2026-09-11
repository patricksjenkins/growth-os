'use strict';

/**
 * Deterministic safety boundary for FGA's public demo form.
 *
 * This is deliberately scoped to FGA's own `website_demo_request` intake.
 * Customer-tenant capture behavior is unchanged. A suspicious request is
 * retained as a quarantined lead for audit, but no messaging, enrichment,
 * scoring, follow-up, or owner-alert agent is allowed to act on it.
 */

const FGA_DEMO_CAPTURE_SCHEMA = 'fga-demo-v2';
const MIN_FORM_AGE_MS = 2_000;
const MAX_FORM_AGE_MS = 24 * 60 * 60 * 1000;

function truthy(value) {
  return value === true || value === 'true' || value === 'on' || value === 1;
}

function assessFgaDemoCapture(body = {}, { now = Date.now() } = {}) {
  const honeypot = String(body.website || '').trim();
  if (honeypot) {
    return {
      accepted: false,
      silent_drop: true,
      contact_allowed: false,
      reasons: ['honeypot_filled'],
    };
  }

  const reasons = [];
  if (body.capture_schema !== FGA_DEMO_CAPTURE_SCHEMA) reasons.push('capture_schema_missing');
  if (!truthy(body.sms_consent)) reasons.push('sms_consent_unproven');

  const startedAt = Number(body.form_started_at);
  const observedAt = Number(now);
  const formAge = observedAt - startedAt;
  if (!Number.isFinite(startedAt) || !Number.isFinite(observedAt)) {
    reasons.push('form_timing_missing');
  } else if (formAge < MIN_FORM_AGE_MS) {
    reasons.push('form_completed_too_fast');
  } else if (formAge > MAX_FORM_AGE_MS) {
    reasons.push('form_session_stale');
  }

  // The production burst that generated 22 failed speed-to-lead jobs used a
  // ten-digit value as the free-text message on every submission. A visitor
  // already supplies a phone in its own field; a second bare phone-like value
  // in "anything else" is machine-pattern evidence and must not trigger SMS.
  const freeText = String(body.message || '').trim().replace(/[\s().+-]/g, '');
  if (/^\d{7,18}$/.test(freeText)) reasons.push('numeric_only_free_text');

  return {
    accepted: true,
    silent_drop: false,
    contact_allowed: reasons.length === 0,
    reasons,
  };
}

function automatedContactAllowed(lead) {
  return lead?.metadata?.intake_safety?.contact_allowed !== false;
}

module.exports = {
  FGA_DEMO_CAPTURE_SCHEMA,
  MIN_FORM_AGE_MS,
  MAX_FORM_AGE_MS,
  assessFgaDemoCapture,
  automatedContactAllowed,
};
