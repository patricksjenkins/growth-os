/**
 * core/lead-alerts.js — owner notifications + tenant webhook for INBOUND leads.
 *
 * One shared implementation for every capture path (website form via
 * /api/leads/capture, web chat via /api/chat, future channels) so the alert
 * rules can't drift per call site:
 *
 *  - EMAIL alert (tenant_config.lead_alert_email, comma-separated): From is
 *    tenant_config.lead_alert_from if set, else a tenant-branded sender on the
 *    platform's verified domain — NEVER the personal platform default (P0,
 *    2026-07-14). Reply-To is the lead, so replying answers the customer.
 *  - SMS alert (tenant_config.lead_alert_sms + a provisioned tenant number).
 *  - WEBHOOK (tenant_config.lead_webhook_url + lead_webhook_secret): POSTs the
 *    lead to the tenant's own system (e.g. the 923A Command Center) so the
 *    lead shows up where the owner actually works. Secret rides in the
 *    X-Lead-Webhook-Secret header; the receiver verifies it against the same
 *    tenant_config row.
 *
 * Everything here is fire-and-forget: an alert failure must never break the
 * capture that triggered it. Callers should invoke without awaiting, or catch.
 */

const { db } = require('../db/client');
const { createLogger } = require('./logger');

const log = createLogger('lead-alerts');

const esc = (s) => String(s || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

async function tenantCfg(tenantId, keys) {
  const { data: rows } = await db
    .from('tenant_config')
    .select('key, value')
    .eq('tenant_id', tenantId)
    .in('key', keys);
  return Object.fromEntries((rows || []).map((r) => [r.key, r.value]));
}

function sourceLabel(source) {
  const s = String(source || '').toLowerCase();
  if (s === 'web_chat') return 'your website chat';
  if (s.startsWith('website')) return 'your website';
  if (s === 'missed_call') return 'a missed call';
  if (s === 'voice_receptionist') return 'your AI receptionist';
  if (s === 'inbound_sms') return 'an inbound text';
  return 'your website';
}

/** Email + SMS alert to the tenant owner about a newly captured inbound lead. */
async function notifyOwnerNewLead(tenantId, { leadId, name, email, phone, message, source }) {
  // ---- email alert -------------------------------------------------------
  try {
    const cfg = await tenantCfg(tenantId, ['lead_alert_email', 'lead_alert_from', 'business_name']);
    const alertRaw = cfg.lead_alert_email ? String(cfg.lead_alert_email).trim() : '';
    const recipients = alertRaw ? alertRaw.split(',').map((s) => s.trim()).filter(Boolean) : [];
    if (recipients.length) {
      const { sendEmail } = require('../integrations/email');
      const bizName = cfg.business_name ? String(cfg.business_name).trim() : '';
      const subject = `New lead from ${sourceLabel(source)}: ${esc(name)}`;
      const html = `<h2 style="margin:0 0 12px">New lead from ${esc(sourceLabel(source))}</h2>
<p><strong>Name:</strong> ${esc(name)}</p>
<p><strong>Phone:</strong> ${esc(phone) || '—'}</p>
<p><strong>Email:</strong> ${esc(email) || '—'}</p>
<p><strong>Source:</strong> ${esc(source)}</p>
<p><strong>Details:</strong><br>${esc(message) || '—'}</p>
<hr><p style="color:#64748b;font-size:13px">Captured by First Gen Automate${bizName ? ` for ${esc(bizName)}` : ''}. Reply to this email to reply to the lead directly. Reply fast — speed wins the job.</p>`;
      // Sender identity (P0): lead_alert_from if configured (verified domain),
      // else tenant-branded alerts sender. Never the personal platform default.
      const opts = {};
      if (cfg.lead_alert_from) {
        opts.from = String(cfg.lead_alert_from).trim();
      } else {
        const fromName = (bizName ? `${bizName} Leads` : 'First Gen Automate Leads').replace(/["<>]/g, '');
        opts.from = `${fromName} <alerts@firstgenautomate.com>`;
      }
      if (email) opts.replyTo = email;
      await sendEmail(recipients.length === 1 ? recipients[0] : recipients, subject, html, opts);
      log.info(`New-lead alert emailed to ${recipients.length} recipient(s) for lead ${leadId}`);
    }
  } catch (mailErr) {
    log.warn(`New-lead alert email failed for lead ${leadId}: ${mailErr.message}`);
  }

  // ---- SMS alert ---------------------------------------------------------
  try {
    const sc = await tenantCfg(tenantId, ['lead_alert_sms', 'telnyx_phone_number', 'tier']);
    const alertTo = sc.lead_alert_sms ? String(sc.lead_alert_sms).trim() : '';
    if (alertTo && sc.telnyx_phone_number) {
      const { sendSms } = require('../integrations/telnyx');
      const smsTenant = { id: tenantId, config: { telnyx_phone_number: sc.telnyx_phone_number, tier: sc.tier || 'growth' } };
      const extra = [phone, message].filter(Boolean).join(' | ');
      const smsBody = `New lead from ${sourceLabel(source)}: ${name}${extra ? ' — ' + extra : ''}`.slice(0, 320);
      await sendSms(null, alertTo, smsBody, { tenant: smsTenant });
      log.info(`New-lead SMS alert sent to ${alertTo} for lead ${leadId}`);
    }
  } catch (smsErr) {
    log.warn(`New-lead SMS alert failed for lead ${leadId}: ${smsErr.message}`);
  }
}

/**
 * POST the captured lead to the tenant's own system (opt-in per tenant via
 * tenant_config.lead_webhook_url). Used so channels that capture directly in
 * growth-os (web chat) still surface the lead in the tenant's Command Center.
 * NOTE: capture paths where the tenant's own site initiated the capture (the
 * 923A form posts through its own /api/lead first) must NOT also webhook, or
 * the lead would appear twice.
 */
async function postLeadWebhook(tenantId, { leadId, name, email, phone, message, source }) {
  try {
    const cfg = await tenantCfg(tenantId, ['lead_webhook_url', 'lead_webhook_secret']);
    const url = cfg.lead_webhook_url ? String(cfg.lead_webhook_url).trim() : '';
    if (!/^https:\/\//i.test(url)) return; // opt-in, https only
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.lead_webhook_secret ? { 'X-Lead-Webhook-Secret': String(cfg.lead_webhook_secret).trim() } : {}),
      },
      body: JSON.stringify({ lead_id: leadId, name, email: email || null, phone: phone || null, message: message || null, source }),
    });
    if (!r.ok) log.warn(`Lead webhook ${url} returned ${r.status} for lead ${leadId}`);
    else log.info(`Lead webhook delivered for lead ${leadId} (${source})`);
  } catch (err) {
    log.warn(`Lead webhook failed for lead ${leadId}: ${err.message}`);
  }
}

module.exports = { notifyOwnerNewLead, postLeadWebhook };
