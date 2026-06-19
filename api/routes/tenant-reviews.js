/**
 * Tenant Reviews — owner-portal review-request command center.
 *
 * Model (decided 2026-06-19): the owner manually ADDS customers going forward
 * (name + email + phone + what the job was), then sends or copies a review
 * request and tracks status. Candidates are NOT mined from finance history
 * (no emails there). Email sends via Resend; Copy Message is the fallback.
 *
 * Mounted at /api/tenant/reviews (behind authMiddleware + tenantMiddleware).
 */

const express = require('express');
const router = express.Router();
const { getUserClient } = require('../../db/userClient');
const { sendEmail } = require('../../integrations/email');
const { createLogger } = require('../../core/logger');
const log = createLogger('tenant-reviews');

const CFG_KEYS = ['review_links', 'review_url', 'business_name', 'lead_alert_from', 'review_email_from'];

async function loadConfig(db, tenantId) {
  const { data } = await db.from('tenant_config').select('key, value').eq('tenant_id', tenantId).in('key', CFG_KEYS);
  const cfg = {};
  (data || []).forEach((r) => { cfg[r.key] = r.value; });
  return cfg;
}

function parseLinks(cfg) {
  if (cfg.review_links) {
    try { const arr = JSON.parse(cfg.review_links); if (Array.isArray(arr)) return arr; } catch (_) { /* fall through */ }
  }
  // Seed from the legacy single review_url (Google) if present.
  const seed = [];
  if (cfg.review_url) seed.push({ label: 'Google Review', url: cfg.review_url, enabled: true });
  return seed;
}

function buildEmailHtml(firstName, biz, links) {
  const buttons = links.map((l) =>
    `<a href="${l.url}" style="display:inline-block;background:#1F5130;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:700;margin:6px 8px 6px 0;font-family:Arial,Helvetica,sans-serif;">${l.label}</a>`
  ).join('');
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;color:#22312b;max-width:540px;margin:0 auto;line-height:1.55;">
  <p>Hi ${firstName || 'there'},</p>
  <p>Thank you for choosing ${biz}. We appreciate the opportunity to help with your tree-service needs.</p>
  <p>If you were happy with our work, would you mind leaving us a quick review? Reviews help local customers find and trust our business.</p>
  <p>You can leave a review here:</p>
  <p>${buttons}</p>
  <p>Thank you again for your business.</p>
  <p style="font-weight:700;">${biz}</p>
</div>`;
}

// GET /api/tenant/reviews — review links + all tracked customers
router.get('/', async (req, res) => {
  try {
    const db = getUserClient(req);
    const cfg = await loadConfig(db, req.tenantId);
    const { data: customers, error } = await db
      .from('customer_reviews')
      .select('*')
      .eq('tenant_id', req.tenantId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({
      success: true,
      data: {
        links: parseLinks(cfg),
        customers: customers || [],
        business_name: cfg.business_name || 'A Kut Above Tree Services',
      },
    });
  } catch (err) {
    log.error(`GET reviews failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/tenant/reviews/links — save the review links list
router.put('/links', async (req, res) => {
  try {
    const db = getUserClient(req);
    const links = Array.isArray(req.body.links) ? req.body.links : [];
    const { error } = await db
      .from('tenant_config')
      .upsert({ tenant_id: req.tenantId, key: 'review_links', value: JSON.stringify(links) }, { onConflict: 'tenant_id,key' });
    if (error) throw error;
    res.json({ success: true, data: { links } });
  } catch (err) {
    log.error(`save links failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/tenant/reviews/customers — add a customer to ask for a review
router.post('/customers', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { customer_name, customer_email, customer_phone, service_type, notes } = req.body || {};
    if (!customer_name || !String(customer_name).trim()) {
      return res.status(400).json({ success: false, error: 'Customer name is required.' });
    }
    const { data, error } = await db
      .from('customer_reviews')
      .insert({
        tenant_id: req.tenantId,
        customer_name: String(customer_name).trim(),
        customer_email: customer_email ? String(customer_email).trim() : null,
        customer_phone: customer_phone ? String(customer_phone).trim() : null,
        service_type: service_type ? String(service_type).trim() : null,
        notes: notes ? String(notes).trim() : null,
        status: 'not_sent',
      })
      .select()
      .single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    log.error(`add customer failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /api/tenant/reviews/customers/:id — update a customer / status
router.patch('/customers/:id', async (req, res) => {
  try {
    const db = getUserClient(req);
    const allowed = ['customer_name', 'customer_email', 'customer_phone', 'service_type', 'notes', 'status', 'review_source'];
    const updates = { updated_at: new Date().toISOString() };
    for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k];
    if (updates.status === 'received') updates.received_at = new Date().toISOString();
    if (updates.status === 'do_not_ask') updates.do_not_request = true;
    if (updates.status === 'not_sent') updates.do_not_request = false;
    const { data, error } = await db
      .from('customer_reviews')
      .update(updates)
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    log.error(`update customer failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/tenant/reviews/customers/:id — remove a customer
router.delete('/customers/:id', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { error } = await db.from('customer_reviews').delete().eq('tenant_id', req.tenantId).eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/tenant/reviews/customers/:id/send — email the review request
router.post('/customers/:id/send', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { data: cust, error: cErr } = await db
      .from('customer_reviews').select('*').eq('tenant_id', req.tenantId).eq('id', req.params.id).single();
    if (cErr || !cust) return res.status(404).json({ success: false, error: 'Customer not found.' });
    if (cust.do_not_request) return res.status(400).json({ success: false, error: 'This customer is marked Do Not Ask Again.' });
    if (!cust.customer_email) return res.status(400).json({ success: false, error: 'No email on file — add an email or use Copy Message.' });

    const cfg = await loadConfig(db, req.tenantId);
    const links = parseLinks(cfg).filter((l) => l.enabled !== false && l.url);
    if (!links.length) return res.status(400).json({ success: false, error: 'No review links configured yet.' });

    const biz = cfg.business_name || 'A Kut Above Tree Services';
    const first = String(cust.customer_name).trim().split(/\s+/)[0];
    const subject = `Thank you for choosing ${biz}`;
    const html = buildEmailHtml(first, biz, links);
    const from = cfg.review_email_from || cfg.lead_alert_from || undefined;

    try {
      await sendEmail(cust.customer_email, subject, html, { from, tenant: { id: req.tenantId } });
    } catch (sendErr) {
      await db.from('customer_reviews').update({ last_error: sendErr.message, updated_at: new Date().toISOString() })
        .eq('tenant_id', req.tenantId).eq('id', cust.id);
      return res.status(502).json({ success: false, error: `Email could not be sent: ${sendErr.message}` });
    }

    const { data, error } = await db.from('customer_reviews').update({
      status: 'sent', sent_at: new Date().toISOString(), sent_to: cust.customer_email,
      channel: 'email', request_count: (cust.request_count || 0) + 1, last_error: null,
      updated_at: new Date().toISOString(),
    }).eq('tenant_id', req.tenantId).eq('id', cust.id).select().single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    log.error(`send review failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
