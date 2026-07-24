/**
 * Growth OS — Calendly Webhook Handler
 * Handles meeting bookings and cancellations
 */

const express = require('express');
const router = express.Router();
const { createLogger } = require('../../core/logger');
const { verifyCalendlySignature } = require('../middleware/webhookVerify');
const { resolveTenant } = require('../../core/tenant');
const { getServiceClient } = require('../../db/client');
const { db } = require('../../db/client');
const { isModuleEnabled } = require('../../core/modules');
const { enqueueJob } = require('../../db/queries/jobs');
const { flags } = require('../../core/autonomous-os/feature-flags');
const { tenantInCohort } = require('../../core/autonomous-os/cohort');
const {
  normalizeCalendlyEvent,
} = require('../../core/scheduling/calendly-adapter');

const log = createLogger('calendly');

async function projectCanonicalAppointment({
  client,
  tenantId,
  eventType,
  payload,
  leadId = null,
}) {
  if (
    !flags.schedulingWrites()
    || !flags.strictWebhookVerification()
    || !tenantInCohort(tenantId, 'FGA_OS_SCHEDULING_TENANT_ALLOWLIST')
  ) {
    return { mode: 'disabled' };
  }

  const normalized = normalizeCalendlyEvent({
    tenantId,
    eventType,
    payload,
    leadId,
    appointmentType: 'discovery',
  });
  if (!normalized.ok) {
    const error = new Error(`calendly_projection_invalid:${normalized.errors.join(',')}`);
    error.code = 'CALENDLY_PROJECTION_INVALID';
    throw error;
  }
  const event = normalized.event;
  const { data, error } = await client.rpc('appointment_provider_event_rpc', {
    p_tenant_id: event.tenant_id,
    p_provider: event.provider,
    p_provider_event_id: event.provider_event_id,
    p_event_type: event.event_type,
    p_appointment_type: event.appointment_type,
    p_lead_id: event.lead_id,
    p_scheduled_start: event.scheduled_start,
    p_scheduled_end: event.scheduled_end,
    p_idempotency_key: normalized.idempotency_key,
    p_request_fingerprint: normalized.request_fingerprint,
    p_feature_gate_enabled: true,
  });
  if (error) throw error;

  const expectedStatus = event.event_type === 'booked' ? 'scheduled' : 'cancelled';
  if (
    !['scheduled', 'cancelled', 'replay'].includes(data?.outcome)
    || data?.appointment?.tenant_id !== event.tenant_id
    || data?.appointment?.provider !== 'calendly'
    || data?.appointment?.provider_event_id !== event.provider_event_id
    || data?.appointment?.status !== expectedStatus
    || data?.event?.tenant_id !== event.tenant_id
    || data?.event?.appointment_id !== data?.appointment?.id
  ) {
    const error = new Error('calendly_projection_result_invalid');
    error.code = 'CALENDLY_PROJECTION_RESULT_INVALID';
    throw error;
  }
  return {
    mode: 'canonical',
    outcome: data.outcome,
    appointment_id: data.appointment.id,
  };
}

async function projectOrEscalate(input) {
  try {
    return await projectCanonicalAppointment(input);
  } catch (error) {
    log.warn(`Canonical appointment projection failed closed: ${error.code || 'provider_error'}`);
    try {
      await input.client.from('attention_queue').insert({
        tenant_id: input.tenantId,
        type: 'scheduling_projection_failed',
        severity: 'amber',
        title: 'Verified Calendly event needs canonical reconciliation',
        summary: 'The legacy meeting receipt was preserved, but the canonical scheduling projection failed.',
        entity_type: 'calendly_event',
        entity_id: null,
        payload: {},
        produced_by: 'calendly-webhook',
      });
    } catch (_) {
      // Existing Calendly receipt behavior must remain available while the
      // canonical path is supervised and disabled by default.
    }
    return { mode: 'exception', code: error.code || 'PROJECTION_FAILED' };
  }
}

/**
 * Calendly webhook
 * POST /webhooks/calendly/:tenantSlug
 *
 * Tenant is identified by the slug in the URL (configured in Calendly's webhook settings)
 */
router.post('/:tenantSlug', express.json(), async (req, res) => {
  try {
    const { tenantSlug } = req.params;
    const { getTenantBySlug } = require('../../db/queries/config');

    const tenantRow = await getTenantBySlug(tenantSlug);
    if (!tenantRow) {
      log.warn(`Unknown tenant slug in webhook: ${tenantSlug}`);
      return res.status(404).json({ error: 'Unknown tenant' });
    }

    const supabase = getServiceClient();
    req.tenant = await resolveTenant(supabase, tenantRow.id);
    req.tenantId = tenantRow.id;

    // Verify signature if configured
    verifyCalendlySignature(req, res, async () => {
      const event = req.body;
      const eventType = event.event; // 'invitee.created' or 'invitee.canceled'
      const payload = event.payload || {};

      log.info(`Event: ${eventType} for ${tenantSlug}`);

      if (eventType === 'invitee.created') {
        // New meeting booked
        const invitee = payload.invitee || {};
        const scheduledEvent = payload.event || {};
        const externalId = scheduledEvent.uri || payload.uri;

        // V1 hardening (2026-05-24): idempotency. Calendly retries
        // non-2xx for up to 5 days — without this guard a transient
        // blip duplicates the meeting row on every retry. Upsert on
        // external_id; downstream meeting-prep enqueue only fires
        // when this is a genuinely new insert.
        const meetingData = {
          tenant_id: req.tenantId,
          external_id: externalId,
          scheduled_at: scheduledEvent.start_time,
          duration_minutes: scheduledEvent.duration || 30,
          meeting_type: 'discovery',
          status: 'scheduled',
          notes: `Booked by ${invitee.name} (${invitee.email})`
        };

        // Try to match to existing contact. .maybeSingle() returns null
        // gracefully on no match; .single() (the original) threw.
        const { data: contact } = await db
          .from('contacts')
          .select('id, lead_id')
          .eq('tenant_id', req.tenantId)
          .eq('email', invitee.email)
          .maybeSingle();

        if (contact) meetingData.contact_id = contact.id;

        // Check for existing first so we know whether to enqueue meeting-prep.
        const { data: existing } = await db
          .from('meetings')
          .select('id')
          .eq('tenant_id', req.tenantId)
          .eq('external_id', externalId)
          .maybeSingle();

        if (existing) {
          log.info(`Meeting already recorded for ${externalId} — replay ignored`);
        } else {
          await db.from('meetings').insert(meetingData);
          log.success(`Meeting created: ${invitee.name} at ${scheduledEvent.start_time}`);

          // Enqueue meeting prep ONLY for net-new meetings to avoid
          // duplicate brief generation on retries.
          if (isModuleEnabled(req.tenant, 'lead_capture') && contact) {
            await enqueueJob(req.tenantId, 'meeting-prep', {
              contact_id: contact.id,
              meeting_time: scheduledEvent.start_time,
              invitee_name: invitee.name,
              invitee_email: invitee.email
            });
          }
        }

        await projectOrEscalate({
          client: supabase,
          tenantId: req.tenantId,
          eventType,
          payload,
          leadId: contact?.lead_id || null,
        });
      }

      if (eventType === 'invitee.canceled') {
        const canceledEvent = payload.event || {};
        const externalId = canceledEvent.uri || payload.uri;

        // V1 hardening (2026-05-24): handle the case where the cancel
        // arrives before the create (Calendly events can race) — emit
        // a reconciliation row to attention_queue so Patrick can chase
        // it down. We also refuse to flip 'completed' meetings back to
        // 'cancelled', which would corrupt historical pipeline metrics.
        const { data: existing } = await db
          .from('meetings')
          .select('id, status')
          .eq('tenant_id', req.tenantId)
          .eq('external_id', externalId)
          .maybeSingle();

        if (!existing) {
          log.warn(`Cancel received for unknown meeting ${externalId} — possible race`);
          try {
            await db.from('attention_queue').insert({
              tenant_id: req.tenantId,
              type: 'meeting_cancel_orphan',
              severity: 'amber',
              title: 'Calendly cancellation for unknown meeting',
              payload: { external_id: externalId, raw_event: payload },
              produced_by: 'calendly-webhook',
            });
          } catch (_) { /* attention queue is best-effort */ }
        } else if (existing.status === 'completed') {
          log.warn(`Refusing to cancel completed meeting ${existing.id}`);
        } else {
          await db
            .from('meetings')
            .update({ status: 'cancelled' })
            .eq('id', existing.id);
          log.info('Meeting cancelled');
        }

        await projectOrEscalate({
          client: supabase,
          tenantId: req.tenantId,
          eventType,
          payload,
        });
      }

      res.json({ received: true });
    });
  } catch (err) {
    log.error('Calendly webhook failed', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

module.exports = router;
module.exports._internal = {
  projectCanonicalAppointment,
  projectOrEscalate,
};
