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

const log = createLogger('calendly');

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
          .select('id')
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
      }

      res.json({ received: true });
    });
  } catch (err) {
    log.error('Calendly webhook failed', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

module.exports = router;
