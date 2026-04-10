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

        const meetingData = {
          tenant_id: req.tenantId,
          external_id: scheduledEvent.uri || payload.uri,
          scheduled_at: scheduledEvent.start_time,
          duration_minutes: scheduledEvent.duration || 30,
          meeting_type: 'discovery',
          status: 'scheduled',
          notes: `Booked by ${invitee.name} (${invitee.email})`
        };

        // Try to match to existing contact
        const { data: contact } = await db
          .from('contacts')
          .select('id')
          .eq('tenant_id', req.tenantId)
          .eq('email', invitee.email)
          .single();

        if (contact) meetingData.contact_id = contact.id;

        await db.from('meetings').insert(meetingData);
        log.success(`Meeting created: ${invitee.name} at ${scheduledEvent.start_time}`);

        // Enqueue meeting prep if module enabled
        if (isModuleEnabled(req.tenant, 'lead_capture') && contact) {
          await enqueueJob(req.tenantId, 'meeting-prep', {
            contact_id: contact.id,
            meeting_time: scheduledEvent.start_time,
            invitee_name: invitee.name,
            invitee_email: invitee.email
          });
        }
      }

      if (eventType === 'invitee.canceled') {
        const canceledEvent = payload.event || {};
        await db
          .from('meetings')
          .update({ status: 'cancelled' })
          .eq('tenant_id', req.tenantId)
          .eq('external_id', canceledEvent.uri || payload.uri);

        log.info('Meeting cancelled');
      }

      res.json({ received: true });
    });
  } catch (err) {
    log.error('Calendly webhook failed', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

module.exports = router;
