/**
 * Resend webhook — complete delivery lifecycle ingestion
 *
 * The deliverability backbone for autonomous outreach:
 *  - email.bounced    -> permanent suppression (drip_suppressions) + lead
 *                        automation_status='bounced' + stop active drip
 *  - email.complained -> same, plus a RED attention item (complaints are the
 *                        fastest way to burn a domain — the auto-outreach
 *                        circuit breaker pauses on ANY complaint in 7d)
 *  - all provider lifecycle events are recorded for diagnosis and cohorts
 *
 * Every event lands in email_events (deduped on the immutable Svix event ID),
 * which core/auto-outreach.js computeCapState reads for the 7-day bounce-rate
 * circuit breaker.
 *
 * Signature: Resend signs with Svix. Headers svix-id / svix-timestamp /
 * svix-signature; signed content is `${id}.${timestamp}.${rawBody}` HMAC
 * SHA-256 with the whsec_ secret (base64 portion). Set RESEND_WEBHOOK_SECRET
 * in Railway after creating the webhook endpoint in the Resend dashboard
 * (Webhooks -> Add -> https://<api>/webhooks/resend, events: email.bounced,
 * email.complained, email.delivered).
 *
 * Activation requirement: RESEND_WEBHOOK_SECRET plus strict webhook
 * verification. Missing verification is surfaced as a deployment blocker.
 */

const express = require('express');
const crypto = require('crypto');
const { createLogger } = require('../../core/logger');
const { getServiceClient } = require('../../db/client');
const { FGA_TENANT_ID } = require('../../core/config');
const { flags } = require('../../core/autonomous-os/feature-flags');

const router = express.Router();
const log = createLogger('resend-webhook');

function verifySvixSignature(req) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    if (flags.strictWebhookVerification() || process.env.NODE_ENV === 'production') {
      log.warn('RESEND_WEBHOOK_SECRET not set — strict mode rejected callback');
      return false;
    }
    log.warn('RESEND_WEBHOOK_SECRET not set — accepting event without verification');
    return true;
  }
  const id = req.headers['svix-id'];
  const timestamp = req.headers['svix-timestamp'];
  const sigHeader = req.headers['svix-signature'];
  if (!id || !timestamp || !sigHeader || !req.rawBody) return false;

  // Reject stale timestamps (>5 min) to block replay.
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;

  const secretBytes = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const signedContent = `${id}.${timestamp}.${req.rawBody.toString('utf8')}`;
  const expected = crypto.createHmac('sha256', secretBytes).update(signedContent).digest('base64');

  // Header format: "v1,<base64sig> v1,<base64sig2> ..."
  return sigHeader.split(' ').some((part) => {
    const sig = part.split(',')[1];
    if (!sig) return false;
    try {
      return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    } catch { return false; }
  });
}

async function suppressRecipient(db, recipient, reason) {
  // Permanent email suppression — the same table the drip campaign and the
  // auto-outreach suppression gate already consult (unique on tenant+email).
  const { error: suppressionError } = await db.from('drip_suppressions').upsert({
    tenant_id: FGA_TENANT_ID,
    email: recipient,
    reason,
    source: 'resend_webhook',
  }, { onConflict: 'tenant_id,email' });
  if (suppressionError) throw new Error(`suppression_upsert_failed:${suppressionError.message}`);
  log.info(`Suppressed ${recipient} (${reason})`);

  // Reflect on any matching lead + stop an active drip enrollment.
  const { data: leads, error: leadsError } = await db.from('leads')
    .select('id').eq('tenant_id', FGA_TENANT_ID).eq('email', recipient).limit(5);
  if (leadsError) throw new Error(`suppression_lead_lookup_failed:${leadsError.message}`);
  for (const l of leads || []) {
    const { error: leadUpdateError } = await db.from('leads')
      .update({ automation_status: reason === 'bounce' ? 'bounced' : 'unsubscribed' })
      .eq('id', l.id)
      .eq('tenant_id', FGA_TENANT_ID);
    if (leadUpdateError) throw new Error(`suppression_lead_update_failed:${leadUpdateError.message}`);
    const { error: enrollmentError } = await db.from('drip_enrollments')
      .update({ status: 'stopped', stopped_reason: reason, next_send_at: null, updated_at: new Date().toISOString() })
      .eq('tenant_id', FGA_TENANT_ID).eq('lead_id', l.id).eq('status', 'active');
    if (enrollmentError) throw new Error(`suppression_enrollment_update_failed:${enrollmentError.message}`);
  }
}

router.post('/', async (req, res) => {
  try {
    if (!verifySvixSignature(req)) {
      log.warn('Invalid Resend webhook signature — rejected');
      return res.status(401).json({ error: 'invalid signature' });
    }

    const event = req.body || {};
    const type = String(event.type || '');
    const data = event.data || {};
    const recipient = String((Array.isArray(data.to) ? data.to[0] : data.to) || '').toLowerCase().trim();
    const providerEmailId = data.email_id || data.id || null;

    const map = {
      'email.sent': 'sent',
      'email.bounced': 'bounced',
      'email.complained': 'complained',
      'email.delivered': 'delivered',
      'email.delivery_delayed': 'delayed',
      'email.failed': 'failed',
      'email.opened': 'opened',
      'email.clicked': 'clicked',
      'email.suppressed': 'suppressed',
      'email.received': 'received',
    };
    const normalized = map[type];
    if (!normalized) return res.json({ ok: true, ignored: type });

    const db = getServiceClient();
    const providerEventId = String(req.headers['svix-id'] || '').trim() || null;
    if (!providerEventId) return res.status(400).json({ error: 'missing event id' });

    // Idempotent insert by the provider's event id. Multiple opens/clicks for
    // one email are legitimate events and must not collapse into one row.
    const { error: insErr } = await db.from('email_events').insert({
      tenant_id: FGA_TENANT_ID,
      provider: 'resend',
      provider_event_id: providerEventId,
      provider_email_id: providerEmailId,
      recipient: recipient || null,
      event: normalized,
      payload: { type, created_at: event.created_at || null, bounce: data.bounce || null },
    });
    if (insErr && !/duplicate|unique/i.test(insErr.message)) {
      throw new Error(`email_events_insert_failed:${insErr.message}`);
    }

    if (normalized === 'bounced' && recipient) {
      await suppressRecipient(db, recipient, 'bounce');
    }
    if (normalized === 'complained' && recipient) {
      await suppressRecipient(db, recipient, 'complaint');
      await db.from('attention_queue').insert({
        tenant_id: FGA_TENANT_ID,
        type: 'email_complaint',
        severity: 'red',
        title: `Spam complaint from ${recipient}`,
        summary: 'A recipient marked an FGA email as spam. The address is suppressed permanently and the autonomous-outreach circuit breaker pauses sends on any complaint within 7 days. Review recent copy and targeting.',
        payload: { recipient, provider_email_id: providerEmailId },
        produced_by: 'resend-webhook',
      }).then(() => {}, (e) => log.warn(`attention insert failed: ${e.message}`));
    }
    if (normalized === 'suppressed' && recipient) {
      await suppressRecipient(db, recipient, 'provider_suppression');
    }

    if (providerEmailId && ['delivered', 'bounced', 'complained', 'failed', 'suppressed'].includes(normalized)) {
      try {
        let leadId = null;
        const { data: dripSend, error: dripLookupError } = await db.from('drip_sends')
          .select('lead_id').eq('tenant_id', FGA_TENANT_ID)
          .eq('resend_id', providerEmailId).limit(1).maybeSingle();
        if (dripLookupError) throw new Error(`drip_send_correlation_failed:${dripLookupError.message}`);
        leadId = dripSend?.lead_id || null;
        if (!leadId) {
          const { data: sequence, error: sequenceLookupError } = await db.from('outreach_sequences')
            .select('lead_id').eq('tenant_id', FGA_TENANT_ID)
            .contains('metadata', { delivered: { provider_id: providerEmailId } })
            .limit(1).maybeSingle();
          if (sequenceLookupError) throw new Error(`outreach_sequence_correlation_failed:${sequenceLookupError.message}`);
          leadId = sequence?.lead_id || null;
        }
        if (leadId) {
          const { recordGrowthEvent } = require('../../core/growth/events');
          await recordGrowthEvent(db, {
            tenantId: FGA_TENANT_ID,
            leadId,
            eventType: `email_${normalized}`,
            stage: normalized === 'delivered' ? 'delivered' : null,
            sourceSystem: 'resend',
            sourceId: providerEventId,
            actor: 'resend-webhook',
            occurredAt: event.created_at || new Date().toISOString(),
            evidence: { provider_status: normalized, provider_email_id_present: true },
            correlationId: providerEmailId,
          });
        }
      } catch (growthErr) {
        // The provider event is already durable and the retry insert is
        // idempotent by Svix ID. Return 500 so the same callback retries and
        // completes the canonical projection instead of leaving a silent gap.
        throw new Error(`growth_event_projection_failed:${growthErr.message}`);
      }
    }

    return res.json({ ok: true });
  } catch (err) {
    log.error(`Resend webhook failed: ${err.message}`);
    // Non-2xx is intentional: Resend retries delivery. Returning 200 here used
    // to turn internal database failures into permanent evidence loss.
    return res.status(500).json({ ok: false, error: 'event processing failed' });
  }
});

module.exports = router;
module.exports.verifySvixSignature = verifySvixSignature;
