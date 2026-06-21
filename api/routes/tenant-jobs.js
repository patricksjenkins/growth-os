/**
 * Tenant Jobs / Quotes — the owner records a quote (a job in a "quote" status)
 * and moves it through its lifecycle. Quotes reuse the jobs table (decided
 * 2026-06-20): open quote statuses feed Quote Follow-Up; a job marked
 * "completed" becomes review-eligible. Connected to customers via customer_id.
 *
 * Mounted at /api/tenant/jobs (authMiddleware + tenantMiddleware).
 */
const express = require('express');
const router = express.Router();
const { getUserClient } = require('../../db/userClient');
const { upsertServiceCustomer } = require('../../core/customer-linking');
const { QUOTE_OPEN, QUOTE_CLOSED } = require('../../core/outreach');
const { createLogger } = require('../../core/logger');
const log = createLogger('tenant-jobs');

function classify(status, completedDate) {
  if (status === 'completed' || completedDate) return 'completed';
  if (QUOTE_CLOSED.has(status)) return 'closed';
  return 'open';
}

// GET /api/tenant/jobs?view=open|closed|completed|all
router.get('/', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { data: jobs, error } = await db.from('jobs').select('*')
      .eq('tenant_id', req.tenantId).order('created_at', { ascending: false }).limit(500);
    if (error) throw error;
    // attach customer names
    const ids = [...new Set((jobs || []).map((j) => j.customer_id).filter(Boolean))];
    let custMap = {};
    if (ids.length) {
      const { data: cs } = await db.from('customers').select('id, name, email, phone').eq('tenant_id', req.tenantId).in('id', ids);
      (cs || []).forEach((c) => { custMap[c.id] = c; });
    }
    const view = req.query.view || 'all';
    const rows = (jobs || []).map((j) => ({
      ...j,
      bucket: classify(j.status, j.completed_date),
      customer_name: custMap[j.customer_id]?.name || null,
      customer_email: custMap[j.customer_id]?.email || null,
      customer_phone: custMap[j.customer_id]?.phone || null,
    })).filter((j) => view === 'all' || j.bucket === view);
    res.json({ success: true, data: rows });
  } catch (err) {
    log.error(`list jobs failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/tenant/jobs — create a quote/job (links/creates the customer)
router.post('/', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { customer_id, customer_name, customer_email, customer_phone, description, revenue, status, scheduled_date } = req.body || {};
    let custId = customer_id || null;
    if (!custId && customer_name && String(customer_name).trim()) {
      const r = await upsertServiceCustomer(db, req.tenantId, {
        name: customer_name, email: customer_email, phone: customer_phone, service_type: description, source: 'quote',
      });
      if (r.customer) custId = r.customer.id;
    }
    const row = {
      tenant_id: req.tenantId,
      customer_id: custId,
      status: status || 'quote_sent',
      description: description || null,
      revenue: revenue != null && revenue !== '' ? Number(revenue) : null,
      scheduled_date: scheduled_date || null,
      completed_date: (status === 'completed') ? new Date().toISOString().slice(0, 10) : null,
    };
    const { data, error } = await db.from('jobs').insert(row).select().single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    log.error(`create job failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /api/tenant/jobs/:id — update status / fields
router.patch('/:id', async (req, res) => {
  try {
    const db = getUserClient(req);
    const allowed = ['status', 'description', 'revenue', 'scheduled_date', 'notes', 'completed_date'];
    const updates = { updated_at: new Date().toISOString() };
    for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k];
    if (updates.revenue === '') updates.revenue = null;
    if (updates.status === 'completed' && updates.completed_date === undefined) {
      updates.completed_date = new Date().toISOString().slice(0, 10);
    }
    const { data, error } = await db.from('jobs').update(updates)
      .eq('tenant_id', req.tenantId).eq('id', req.params.id).select().single();
    if (error) throw error;

    // If the quote closed (won/lost/etc) or completed, stop any open quote follow-up.
    if (data && (QUOTE_CLOSED.has(data.status) || data.status === 'completed' || data.completed_date)) {
      await db.from('outreach_enrollments')
        .update({ status: 'stopped', stopped_reason: `quote_${data.status}`, next_send_at: null, updated_at: new Date().toISOString() })
        .eq('tenant_id', req.tenantId).eq('job_id', data.id).eq('outreach_type', 'quote')
        .in('status', ['active', 'paused', 'needs_review', 'missing_contact']);
    }
    res.json({ success: true, data });
  } catch (err) {
    log.error(`update job failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/tenant/jobs/:id
router.delete('/:id', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { error } = await db.from('jobs').delete().eq('tenant_id', req.tenantId).eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
