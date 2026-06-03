/**
 * First Gen Automate — Telnyx Webhook (single endpoint)
 *
 * POST /webhooks/telnyx
 *
 * Telnyx posts ALL messaging + (optionally) voice events to one URL, routed by
 * `data.event_type`:
 *   - message.received                     → inbound SMS (two-way replies)
 *   - message.sent / message.finalized     → delivery receipt (DLR)
 *   - call.hangup (unanswered)             → missed-call → Missed Call Text-Back
 *
 * Tenant is resolved by the FGA-side number the event is about (the number the
 * text was sent TO for inbound, the number we sent FROM for DLR, the number
 * that was called for voice) via findTenantByPhone.
 *
 * Signature: Telnyx signs with Ed25519. Headers `telnyx-signature-ed25519`
 * (base64) + `telnyx-timestamp`; signed payload is `${timestamp}|${rawBody}`,
 * verified with the account public key (TELNYX_PUBLIC_KEY). Fail-open with a
 * warning if the public key isn't configured yet (mirrors the old behaviour so
 * inbound still works before signing is set up).
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const { createLogger } = require('../../core/logger');
const { db, getServiceClient } = require('../../db/client');
const { enqueueJob } = require('../../db/queries/jobs');
const { isModuleEnabled } = require('../../core/modules');
const { resolveTenant } = require('../../core/tenant');
const { findTenantByPhone } = require('../../db/queries/config');

const log = createLogger('telnyx-webhook');

// Capture the raw body for signature verification while still parsing JSON.
router.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

function verifyTelnyxSignature(req) {
  const publicKeyB64 = process.env.TELNYX_PUBLIC_KEY;
  const signature = req.headers['telnyx-signature-ed25519'];
  const timestamp = req.headers['telnyx-timestamp'];
  if (!publicKeyB64) { log.warn('TELNYX_PUBLIC_KEY not set — skipping signature verification'); return true; }
  if (!signature || !timestamp) { log.warn('Missing Telnyx signature headers'); return false; }
  try {
    const signed = Buffer.from(`${timestamp}|${req.rawBody}`);
    // Wrap the raw 32-byte Ed25519 key in an SPKI DER header so Node crypto can use it.
    const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKeyB64, 'base64')]);
    const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    return crypto.verify(null, signed, key, Buffer.from(signature, 'base64'));
  } catch (e) {
    log.warn(`Telnyx signature verify error: ${e.message}`);
    return false;
  }
}

async function resolveTenantByNumber(number) {
  if (!number) return null;
  const t = await findTenantByPhone(number);
  if (!t) return null;
  const supabase = getServiceClient();
  return resolveTenant(supabase, t.id);
}

function num(v) { return typeof v === 'string' ? v : (v && v.phone_number) || null; }

router.post('/', async (req, res) => {
  // Always 200 fast so Telnyx doesn't retry; do work after responding where possible.
  if (!verifyTelnyxSignature(req)) return res.status(403).json({ error: 'Invalid signature' });

  const event = req.body?.data || {};
  const type = event.event_type;
  const p = event.payload || {};

  try {
    if (type === 'message.received') {
      await handleInbound(p);
    } else if (type === 'message.sent' || type === 'message.finalized') {
      await handleDeliveryReceipt(p);
    } else if (type === 'call.hangup') {
      await handleCallHangup(p);
    } else {
      // Other events (call.initiated, call.answered, message.queued, etc.) — ack.
    }
  } catch (err) {
    log.error(`Telnyx webhook (${type}) failed: ${err.message}`);
  }
  return res.sendStatus(200);
});

/** Inbound SMS — ports the old /webhooks/twilio/sms logic. */
async function handleInbound(p) {
  const from = num(p.from);
  const toNumber = Array.isArray(p.to) ? num(p.to[0]) : num(p.to);
  const body = p.text || '';
  const sid = p.id;

  const tenant = await resolveTenantByNumber(toNumber);
  if (!tenant) { log.warn(`Inbound SMS to unknown number ${toNumber}`); return; }
  const tenantId = tenant.id;
  const lg = createLogger('telnyx-sms', tenant.slug);
  lg.info(`Inbound SMS from ${from}: "${body.slice(0, 50)}"`);

  // Idempotency — unique(tenant_id, external_id). Telnyx retries on non-2xx.
  if (sid) {
    const { error: dupErr } = await db.from('messages').insert({
      tenant_id: tenantId, channel: 'sms', direction: 'inbound', body,
      external_id: sid, sent_at: new Date().toISOString(),
    });
    if (dupErr && /duplicate key|unique/i.test(dupErr.message || '')) {
      lg.info(`Duplicate inbound SMS ${sid} — ignored`);
      return;
    }
  }

  // Resolve sender to contact/lead.
  let contactId = null, leadId = null;
  const { data: contact } = await db.from('contacts').select('id, lead_id').eq('tenant_id', tenantId).eq('phone', from).maybeSingle();
  if (contact) { contactId = contact.id; leadId = contact.lead_id; }
  else {
    const { data: lead } = await db.from('leads').select('id').eq('tenant_id', tenantId).eq('phone', from).maybeSingle();
    if (lead) leadId = lead.id;
  }
  if (sid && contactId) {
    try { await db.from('messages').update({ contact_id: contactId }).eq('tenant_id', tenantId).eq('external_id', sid); } catch (_) {}
  }

  // Push to owner immediately.
  try {
    const { sendPushToTenant } = require('../../integrations/push');
    const digits = String(from || '').replace(/\D/g, '');
    const pretty = digits.length === 11 && digits.startsWith('1')
      ? `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`
      : digits.length === 10 ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : from;
    const senderLabel = leadId ? `Lead from ${pretty}` : contactId ? `Contact from ${pretty}` : `New text from ${pretty}`;
    sendPushToTenant(tenantId, {
      title: `💬 ${senderLabel}`, body: (body || '').slice(0, 140),
      data: { route: '/voice', type: 'inbound_sms', from, message_sid: sid, lead_id: leadId, contact_id: contactId },
    }).catch(() => {});
  } catch (_) {}

  // Mirror to conversations for the reply-classifier.
  if (leadId || contactId) {
    await db.from('conversations').insert({
      tenant_id: tenantId, lead_id: leadId, contact_id: contactId, channel: 'sms',
      direction: 'inbound', message_body: body, metadata: { external_id: sid, from },
    });
  } else {
    lg.info(`Inbound SMS from unknown sender ${from} — logged to messages only`);
  }

  // Outreach reply → flip text_message_sent → replied.
  if (leadId) {
    try {
      await db.from('leads').update({ status: 'replied', updated_at: new Date().toISOString() })
        .eq('id', leadId).eq('tenant_id', tenantId).eq('status', 'text_message_sent');
    } catch (_) {}
  }

  if (isModuleEnabled(tenant, 'outreach_drip')) {
    await enqueueJob(tenantId, 'reply-classification', { from, body, channel: 'sms', message_sid: sid, lead_id: leadId, contact_id: contactId });
  }
  if (leadId && (isModuleEnabled(tenant, 'speed_to_lead') || isModuleEnabled(tenant, 'missed_call'))) {
    await enqueueJob(tenantId, 'conversation-responder', { from, inbound_body: body, message_sid: sid, lead_id: leadId, contact_id: contactId }, { priority: 9 });
  }
  if (!leadId && !contactId) {
    await enqueueJob(tenantId, 'inbound-sms-responder', { from, inbound_body: body, message_sid: sid }, { priority: 9 });
    lg.info(`Enqueued AI inbound-sms-responder for unknown sender ${from}`);
  }
}

/** Delivery receipt — ports the old /webhooks/twilio/status logic. */
async function handleDeliveryReceipt(p) {
  const sid = p.id;
  const ourNumber = num(p.from);
  const recipient = Array.isArray(p.to) ? p.to[0] : p.to;
  const rawStatus = (recipient && recipient.status) || p.status || null;
  if (!sid || !rawStatus) return;

  const status = rawStatus === 'delivered' ? 'delivered'
    : /fail|expired|undeliv/i.test(rawStatus) ? 'failed'
    : rawStatus === 'sent' ? 'sent' : rawStatus;

  const tenant = await resolveTenantByNumber(ourNumber);
  const tenantId = tenant?.id;
  if (!tenantId) return;

  try { await db.from('messages').update({ status }).eq('tenant_id', tenantId).eq('external_id', sid); } catch (e) { log.warn(`[telnyx/dlr] messages update: ${e.message}`); }
  try {
    const { data: rows } = await db.from('conversations').select('id, metadata')
      .eq('tenant_id', tenantId).eq('channel', 'sms').filter('metadata->>external_id', 'eq', sid).limit(1);
    const row = rows && rows[0];
    if (row) {
      const merged = { ...(row.metadata || {}), delivery_status: status };
      const errors = (recipient && recipient.errors) || [];
      if (errors.length) { merged.error_code = String(errors[0].code || ''); merged.error_message = errors[0].title || null; }
      await db.from('conversations').update({ metadata: merged }).eq('id', row.id);
    }
  } catch (e) { log.warn(`[telnyx/dlr] conversations update: ${e.message}`); }

  if (status === 'failed') log.warn(`[telnyx/dlr] sid=${sid} status=${rawStatus}`);
}

/**
 * Missed-call → Missed Call Text-Back. Fires when a call to a tenant number
 * hangs up without being answered. NOTE: requires the tenant's Telnyx number
 * to be on a Call-Control app that posts events here. Receptionist tenants are
 * handled by Vapi on its own webhook; this path covers non-receptionist
 * missed-call text-back.
 */
async function handleCallHangup(p) {
  const toNumber = num(p.to);
  const from = num(p.from);
  const cause = p.hangup_cause || '';
  // Treat as "missed" when the call ended without a connect.
  const missedCauses = ['timeout', 'user_busy', 'call_rejected', 'no_answer', 'originator_cancel'];
  const isMissed = missedCauses.includes(cause) || (!p.answered && p.hangup_source === 'caller');
  if (!isMissed) return;

  const tenant = await resolveTenantByNumber(toNumber);
  if (!tenant) return;
  const lg = createLogger('telnyx-voice', tenant.slug);

  try {
    const { sendPushToTenant } = require('../../integrations/push');
    const digits = String(from || '').replace(/\D/g, '');
    const pretty = digits.length === 11 && digits.startsWith('1')
      ? `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`
      : digits.length === 10 ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : from;
    sendPushToTenant(tenant.id, {
      title: '📵 Missed call', body: `From ${pretty}`,
      data: { route: '/voice', type: 'missed_call', caller_phone: from },
    }).catch(() => {});
  } catch (_) {}

  if (isModuleEnabled(tenant, 'missed_call')) {
    await enqueueJob(tenant.id, 'missed-call', { from, call_status: 'no-answer', call_sid: p.call_control_id }, { priority: 10 });
    lg.info('Missed-call agent enqueued (Telnyx)');
  }
}

module.exports = router;
