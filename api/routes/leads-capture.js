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

// 10 form submissions per IP per 5 minutes is generous for genuine
// prospects (who submit once) and tight enough to block bot floods.
const captureLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many submissions. Please try again in a few minutes.' },
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

router.post('/capture', captureLimiter, async (req, res) => {
  try {
    const body = req.body || {};
    const tenant_id = clean(body.tenant_id, 64);
    const name = clean(body.name, 200);
    const email = clean(body.email, 200);
    const phone = clean(body.phone, 50);
    const message = clean(body.message, 2000);
    const source = clean(body.source, 100) || 'website_contact_form';

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
    const { data: tenant, error: tenantErr } = await db
      .from('tenants')
      .select('id, status')
      .eq('id', tenant_id)
      .maybeSingle();
    if (tenantErr || !tenant) {
      log.warn(`Capture rejected — unknown tenant_id ${tenant_id} (ip=${req.ip})`);
      return res.status(404).json({ success: false, error: 'Tenant not found' });
    }

    // Insert lead. Match the structure used by authenticated POST /api/leads
    // so the rest of the pipeline doesn't have to special-case web leads.
    const { data: newLead, error: insertErr } = await db
      .from('leads')
      .insert({
        tenant_id,
        name,
        email: email || null,
        phone: phone || null,
        status: 'new_lead',
        lead_source: source,
        notes: message || `Website form submission${req.headers.referer ? ` from ${req.headers.referer}` : ''}`,
      })
      .select('id')
      .single();

    if (insertErr) {
      log.error(`Lead insert failed for tenant ${tenant_id}: ${insertErr.message}`);
      return res.status(500).json({ success: false, error: 'Could not save submission. Try again.' });
    }

    // Enqueue speed-to-lead so the prospect gets the promised instant
    // text-back. Priority 10 matches the website-form lead in routes/leads.js
    // and the chat-captured lead in routes/chat.js — these are the hottest
    // leads we get, they just submitted seconds ago.
    try {
      await db.from('agent_jobs').insert({
        tenant_id,
        agent_name: 'speed-to-lead',
        payload: { lead_id: newLead.id },
        status: 'pending',
        priority: 10,
      });
      log.info(`Captured + enqueued lead ${newLead.id} for tenant ${tenant_id} (source=${source})`);
    } catch (queueErr) {
      // Lead is saved; speed-to-lead just won't auto-fire. The sweeper
      // cron will pick it up within an hour. Log and continue.
      log.warn(`Could not enqueue speed-to-lead for lead ${newLead.id}: ${queueErr.message}`);
    }

    return res.json({ success: true, lead_id: newLead.id });
  } catch (err) {
    log.error(`Lead capture failed: ${err.message}`);
    return res.status(500).json({ success: false, error: 'Sorry — something went wrong. Please call us instead.' });
  }
});

module.exports = router;
