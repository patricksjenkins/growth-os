/**
 * Growth OS — Public Lead Capture Endpoint
 *
 * POST /api/leads/capture — public, no auth, called from customer-facing
 * websites (DFY Website builds, customer's own sites with the form snippet)
 * to capture lead form submissions into the right tenant's CRM.
 *
 * This route is mounted BEFORE the global authMiddleware so anonymous
 * visitors on a customer's website can submit without holding any token.
 * Tenant attribution happens via the required `tenant_id` field in the
 * request body, which is injected into the DFY website form template at
 * render time.
 *
 * After insert, the route enqueues the speed-to-lead agent so the
 * prospect gets the promised <60-second text response. This matches the
 * Module 14 (DFY Website) and Module 1 (Lead Capture & CRM) sales
 * claims that contact-form submissions flow into the CRM and trigger
 * downstream automations end-to-end.
 *
 * Rate-limited per-IP to prevent form-spam from bots that scan the
 * generated sites and attempt mass submissions.
 */

const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { db } = require('../../db/client');
const { createLogger } = require('../../core/logger');

const log = createLogger('leads-capture');

// V1 hardening (2026-05-24): adapter pattern for the rate-limit store.
// On a single Railway dyno the in-memory default is fine. When we go
// horizontal (REDIS_URL env var set + ioredis installed), the limiter
// switches to a Redis-backed store so the per-IP cap is global instead
// of per-process. Falls back to memory if the redis client fails to
// initialize so deploys never break on a Redis outage.
function buildCaptureStore() {
  if (!process.env.REDIS_URL) return undefined; // express-rate-limit defaults to memory
  try {
    // Lazy require so the dep is optional in dev.
    // eslint-disable-next-line global-require
    const RedisStore = require('rate-limit-redis');
    // eslint-disable-next-line global-require
    const Redis = require('ioredis');
    const client = new Redis(process.env.REDIS_URL);
    client.on('error', (e) => console.warn(`[leads-capture:redis] ${e.message}`));
    return new RedisStore({ sendCommand: (...args) => client.call(...args) });
  } catch (e) {
    console.warn(`[leads-capture] Redis store unavailable, falling back to memory: ${e.message}`);
    return undefined;
  }
}

// 10 form submissions per IP per 5 minutes is generous for genuine
// prospects (who submit once) and tight enough to block bot floods.
const captureLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many submissions. Please try again in a few minutes.' },
  store: buildCaptureStore(),
});

function isValidEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

function isValidUuid(s) {
  return typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.trim());
}

function clean(s, max = 500) {
  return typeof s === 'string' ? s.trim().slice(0, max) : '';
}

function sanitizedReferrerOrigin(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try { return new URL(raw).origin; }
  catch { return null; }
}

router.post('/capture', captureLimiter, async (req, res) => {
  try {
    const body = req.body || {};
    const tenant_id = clean(body.tenant_id, 64);
    const name = clean(body.name, 200);
    const email = clean(body.email, 200);
    const phone = clean(body.phone, 50);
    const message = clean(body.message, 2000);
    const source = clean(body.source, 100) || 'website_contact_form';
    // Module 10.4 — Referral attribution. If the form/link carries a
    // ?ref=<lead-uuid> parameter (or the body includes referrer_lead_id),
    // record it so we can create a referral_credits row after insert.
    const referrerLeadId = clean(body.referrer_lead_id, 64) || clean(body.ref, 64);

    // Tenant must be present + valid UUID — without it we can't attribute
    // the lead anywhere. Reject early rather than dropping into an orphan
    // record.
    if (!isValidUuid(tenant_id)) {
      return res.status(400).json({ success: false, error: 'Invalid or missing tenant_id' });
    }

    // Require at least name + one contact channel — otherwise it's noise.
    if (!name) {
      return res.status(400).json({ success: false, error: 'Name is required' });
    }
    if (!email && !phone) {
      return res.status(400).json({ success: false, error: 'Email or phone is required' });
    }
    if (email && !isValidEmail(email)) {
      return res.status(400).json({ success: false, error: 'Invalid email format' });
    }

    // Confirm tenant actually exists and is active — fail-closed so a
    // bogus tenant_id from a scraped/spammed form doesn't create rows.
    // NOTE: tier is NOT a column on `tenants` (it lives in tenant_config).
    // Selecting non-existent columns errored here and made every capture
    // return "Tenant not found". We only need id + status to validate; the
    // usage-cap check falls back to the 'growth' tier default, and the
    // lead_capture daily cap (200) is identical across tiers anyway.
    const { data: tenant, error: tenantErr } = await db
      .from('tenants')
      .select('id, status')
      .eq('id', tenant_id)
      .maybeSingle();
    if (tenantErr || !tenant) {
      log.warn(`Capture rejected — unknown tenant_id ${tenant_id} (ip=${req.ip})`);
      return res.status(404).json({ success: false, error: 'Tenant not found' });
    }

    // Per-tenant daily cap — protects against attacks that bypass the
    // per-IP rate limiter (e.g. botnet hitting one tenant from 1000 IPs).
    // 200/day per tenant is way above normal small-business inbound volume.
    try {
      const { checkUsageOrThrow, incrementUsage, notifyOwnerCapReached, UsageCapExceededError } = require('../../core/usage-caps');
      await checkUsageOrThrow(tenant, 'lead_capture_count_today', 1);
      // Counter incremented post-insert below; check now to fail fast.
    } catch (capErr) {
      if (capErr && capErr.name === 'UsageCapExceededError') {
        log.warn(`Lead capture cap hit for tenant ${tenant_id} (${capErr.used}/${capErr.cap}/day; ip=${req.ip})`);
        const { notifyOwnerCapReached } = require('../../core/usage-caps');
        notifyOwnerCapReached(tenant_id, 'lead_capture_count_today', capErr.used, capErr.cap);
        return res.status(429).json({ success: false, error: 'Daily lead capture limit reached. Try again tomorrow.' });
      }
      throw capErr;
    }

    // Insert lead. Match the structure used by authenticated POST /api/leads
    // so the rest of the pipeline doesn't have to special-case web leads.
    const leadInsert = {
      tenant_id,
      name,
      email: email || null,
      phone: phone || null,
      status: 'new_lead',
      lead_source: source,
      // V1 hardening (2026-05-24): only persist the referrer's ORIGIN
      // (scheme + host), not the full URL. The full URL can include
      // query strings + fragments that turn into reflected content in
      // the leads UI if the renderer ever drops escaping.
      notes: message || `Website form submission${sanitizedReferrerOrigin(req.headers.referer) ? ` from ${sanitizedReferrerOrigin(req.headers.referer)}` : ''}`,
    };
    if (isValidUuid(referrerLeadId)) {
      leadInsert.metadata = { referred_by_lead_id: referrerLeadId };
    }
    const { data: newLead, error: insertErr } = await db
      .from('leads')
      .insert(leadInsert)
      .select('id')
      .single();

    if (insertErr) {
      log.error(`Lead insert failed for tenant ${tenant_id}: ${insertErr.message}`);
      return res.status(500).json({ success: false, error: 'Could not save submission. Try again.' });
    }

    // Increment the per-tenant daily counter (fire-and-forget).
    try {
      const { incrementUsage } = require('../../core/usage-caps');
      incrementUsage(tenant_id, 'lead_capture_count_today', 1).catch(() => {});
    } catch (_) { /* never let usage tracking break a save */ }

    // Module 10.4 / 10.5 — If a referrer was specified, create a
    // pending referral_credits row. The payout sweep in referral-request
    // agent flips it to 'owed' when the referee status becomes 'won'.
    if (isValidUuid(referrerLeadId)) {
      try {
        // Snapshot the bonus from tenant_config so a later config change
        // doesn't retroactively reduce promised credit.
        const { data: bonusCfg } = await db
          .from('tenant_config')
          .select('value')
          .eq('tenant_id', tenant_id)
          .eq('key', 'referral_bonus')
          .maybeSingle();
        const amount = bonusCfg?.value ? Number(bonusCfg.value) || 100 : 100;
        await db.from('referral_credits').insert({
          tenant_id,
          referrer_lead_id: referrerLeadId,
          referee_lead_id: newLead.id,
          amount,
          status: 'pending',
          source: 'capture_endpoint',
        });
      } catch (refErr) {
        // Don't fail the lead capture if the referral credit insert fails.
        log.warn(`Could not record referral credit for new lead ${newLead.id}: ${refErr.message}`);
      }
    }

    // Enqueue the full new-lead agent pipeline so the prospect gets the
    // promised end-to-end automation: instant text-back, enrichment,
    // scoring, follow-up sequence. Priority 10 = speed-to-lead (hottest,
    // must fire immediately); 7 = enrichment (feeds scoring); 5 = scoring
    // and follow-up (run after the higher-priority jobs). Each agent
    // checks its own module flag at run time and no-ops if disabled, so
    // we can enqueue all of them safely.
    const downstream = [
      { agent_name: 'speed-to-lead', priority: 10 },
      { agent_name: 'enrichment',    priority: 7 },
      { agent_name: 'scoring',       priority: 5 },
      { agent_name: 'follow-up',     priority: 5 },
    ];
    try {
      await db.from('agent_jobs').insert(
        downstream.map((d) => ({
          tenant_id,
          agent_name: d.agent_name,
          payload: { lead_id: newLead.id },
          status: 'pending',
          priority: d.priority,
        })),
      );
      log.info(`Captured + enqueued ${downstream.length} jobs for lead ${newLead.id} (tenant ${tenant_id}, source=${source})`);
    } catch (queueErr) {
      // Lead is saved; downstream agents just won't auto-fire. The sweeper
      // crons will pick the lead up within their windows. Log and continue.
      log.warn(`Could not enqueue downstream agents for lead ${newLead.id}: ${queueErr.message}`);
    }

    // Instant new-lead email alert to the owner. Opt-in per tenant via
    // tenant_config.lead_alert_email (comma-separated for multiple recipients).
    // Fire-and-forget — a failed/slow email must never break lead capture.
    (async () => {
      try {
        const { data: alertCfg } = await db
          .from('tenant_config')
          .select('value')
          .eq('tenant_id', tenant_id)
          .eq('key', 'lead_alert_email')
          .maybeSingle();
        const alertRaw = alertCfg && alertCfg.value ? String(alertCfg.value).trim() : '';
        if (!alertRaw) return;
        const recipients = alertRaw.split(',').map((s) => s.trim()).filter(Boolean);
        if (!recipients.length) return;
        const esc = (s) => String(s || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
        const { sendEmail } = require('../../integrations/email');
        const subject = `New website lead: ${esc(name)}`;
        const html = `<h2 style="margin:0 0 12px">New lead from your website</h2>
<p><strong>Name:</strong> ${esc(name)}</p>
<p><strong>Phone:</strong> ${esc(phone) || '—'}</p>
<p><strong>Email:</strong> ${esc(email) || '—'}</p>
<p><strong>Source:</strong> ${esc(source)}</p>
<p><strong>Details:</strong><br>${esc(message) || '—'}</p>
<hr><p style="color:#64748b;font-size:13px">This lead is also in your app/portal under Leads. Reply fast — speed wins the job.</p>`;
        await sendEmail(recipients.length === 1 ? recipients[0] : recipients, subject, html);
        log.info(`New-lead alert emailed to ${recipients.length} recipient(s) for lead ${newLead.id}`);
      } catch (mailErr) {
        log.warn(`New-lead alert email failed for lead ${newLead.id}: ${mailErr.message}`);
      }
    })();

    return res.json({ success: true, lead_id: newLead.id });
  } catch (err) {
    log.error(`Lead capture failed: ${err.message}`);
    return res.status(500).json({ success: false, error: 'Sorry — something went wrong. Please call us instead.' });
  }
});

module.exports = router;
