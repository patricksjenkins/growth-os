/**
 * Resend webhook — bounce / complaint / delivered ingestion (2026-07-03)
 *
 * The deliverability backbone for autonomous outreach:
 *  - email.bounced    -> permanent suppression (drip_suppressions) + lead
 *                        automation_status='bounced' + stop active drip
 *  - email.complained -> same, plus a RED attention item (complaints are the
 *                        fastest way to burn a domain — the auto-outreach
 *                        circuit breaker pauses on ANY complaint in 7d)
 *  - email.delivered  -> recorded for the deliverability denominator
 *
 * Every event lands in email_events (deduped on provider_email_id+event),
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
 * Fail-safe: if the secret is configured, invalid signatures are rejected.
 * If it is NOT configured, events are accepted but logged loudly — ingesting
 * bounces matters more than perfect provenance for suppression purposes (the
 * worst an attacker could do is suppress an address, never send email).
 */

const express = require('express');
const crypto = require('crypto');
const { createLogger } = require('../../core/logger');
const { getServiceClient } = require('../../db/client');
const { FGA_TENANT_ID } = require('../../core/config');

const router = express.Router();
const log = createLogger('resend-webhook');

function verifySvixSignature(req) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
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
  await db.from('drip_suppressions').upsert({
    tenant_id: FGA_TENANT_ID,
    email: recipient,
    reason,
    source: 'resend_webhook',
  }, { onConflict: 'tenant_id,email' }).then(
    () => log.info(`Suppressed ${recipient} (${reason})`),
    (e) => log.warn(`Suppression upsert failed for ${recipient}: ${e.message}`),
  );

  // Reflect on any matching lead + stop an active drip enrollment.
  const { data: leads } = await db.from('leads')
    .select('id').eq('tenant_id', FGA_TENANT_ID).eq('email', recipient).limit(5);
  for (const l of leads || []) {
    await db.from('leads')
      .update({ automation_status: reason === 'bounce' ? 'bounced' : 'unsubscribed' })
      .eq('id', l.id);
    await db.from('drip_enrollments')
      .update({ status: 'stopped', stopped_reason: reason, next_send_at: null, updated_at: new Date().toISOString() })
      .eq('tenant_id', FGA_TENANT_ID).eq('lead_id', l.id).eq('status', 'active');
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
      'email.bounced': 'bounced',
      'email.complained': 'complained',
      'email.delivered': 'delivered',
    };
    const normalized = map[type];
    if (!normalized) return res.json({ ok: true, ignored: type });

    const db = getServiceClient();

    // Idempotent insert (unique on provider+email_id+event).
    const { error: insErr } = await db.from('email_events').insert({
      tenant_id: FGA_TENANT_ID,
      provider: 'resend',
      provider_email_id: providerEmailId,
      recipient: recipient || null,
      event: normalized,
      payload: { type, created_at: event.created_at || null, bounce: data.bounce || null },
    });
    if (insErr && !/duplicate|unique/i.test(insErr.message)) {
      log.warn(`email_events insert failed: ${insErr.message}`);
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

    return res.json({ ok: true });
  } catch (err) {
    log.error(`Resend webhook failed: ${err.message}`);
    // 200 so Resend doesn't hammer retries on our own processing bugs;
    // the event is safe to lose only because suppression re-runs on the
    // next occurrence of the same address.
    return res.json({ ok: false });
  }
});

module.exports = router;
