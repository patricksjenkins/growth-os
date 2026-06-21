/**
 * Outreach Center API — one connected system for Review Requests, Quote
 * Follow-Up, Referral Partner outreach, and Commercial Property outreach.
 *
 * Mounted at /api/tenant/outreach (authMiddleware + tenantMiddleware).
 *
 * Owner-in-control model: touches are generated as DRAFTS the owner approves +
 * sends. Auto-send is opt-in per type (tenant_config outreach_autosend_<type>)
 * and only ever applies to follow-up steps (never step 1). SMS only goes to
 * completed-job contacts (core/outreach canText); everything else is email-only.
 */
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { getUserClient } = require('../../db/userClient');
const { db: serviceDb } = require('../../db/client');
const { resolveTenant } = require('../../core/tenant');
const O = require('../../core/outreach');
const { enqueueJob } = require('../../db/queries/jobs');
const { createLogger } = require('../../core/logger');
const log = createLogger('tenant-outreach');

const TYPES = O.OUTREACH_TYPES;
const ACTIVEISH = ['active', 'paused', 'needs_review', 'missing_contact'];

// Recommended additional lead-source categories (surfaced in Settings; off by default).
const LEAD_SOURCES = [
  { key: 'real_estate', label: 'Real estate agents', group: 'referral', recommended: true },
  { key: 'insurance', label: 'Insurance agents', group: 'referral', recommended: true },
  { key: 'property_managers', label: 'Property managers', group: 'commercial', recommended: true },
  { key: 'hoa', label: 'HOA / community managers', group: 'commercial', recommended: true },
  { key: 'apartments', label: 'Apartment communities', group: 'commercial', recommended: true },
  { key: 'churches', label: 'Churches', group: 'commercial', recommended: false },
  { key: 'schools', label: 'Schools / daycares', group: 'commercial', recommended: false },
  { key: 'storage', label: 'Storage facilities', group: 'commercial', recommended: false },
  { key: 'mobile_home', label: 'Mobile home communities', group: 'commercial', recommended: false },
  { key: 'retail', label: 'Local retail centers', group: 'commercial', recommended: false },
  { key: 'office_parks', label: 'Office parks', group: 'commercial', recommended: false },
  { key: 'roofers', label: 'Roofing companies', group: 'referral', recommended: false },
  { key: 'fence', label: 'Fence companies', group: 'referral', recommended: false },
  { key: 'landscapers', label: 'Landscapers / lawn care', group: 'referral', recommended: false },
  { key: 'home_inspectors', label: 'Home inspectors', group: 'referral', recommended: false },
  { key: 'mortgage', label: 'Mortgage brokers', group: 'referral', recommended: false },
  { key: 'builders', label: 'Local builders', group: 'referral', recommended: false },
  { key: 'restoration', label: 'Cleanup / restoration companies', group: 'referral', recommended: false },
];

async function getTenant(req) { return resolveTenant(serviceDb, req.tenantId); }

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
router.get('/dashboard', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { data: enr } = await db.from('outreach_enrollments').select('*').eq('tenant_id', req.tenantId);
    const list = enr || [];
    const now = Date.now();
    const due = (e) => e.status === 'active' && e.next_send_at && new Date(e.next_send_at).getTime() <= now;
    const cards = {
      review_due: list.filter((e) => e.outreach_type === 'review' && due(e)).length,
      quote_due: list.filter((e) => e.outreach_type === 'quote' && due(e)).length,
      partner_drafts: list.filter((e) => e.outreach_type === 'referral_partner' && e.status === 'needs_review').length,
      commercial_drafts: list.filter((e) => e.outreach_type === 'commercial' && e.status === 'needs_review').length,
      active: list.filter((e) => e.status === 'active').length,
      needs_review: list.filter((e) => e.status === 'needs_review').length,
      missing_contact: list.filter((e) => e.status === 'missing_contact').length,
      paused: list.filter((e) => e.status === 'paused').length,
    };
    // counts of un-enrolled candidates
    const { data: revCand } = await db.from('jobs').select('id', { count: 'exact', head: false })
      .eq('tenant_id', req.tenantId).eq('status', 'completed');
    const { data: quoteCand } = await db.from('jobs').select('id, status')
      .eq('tenant_id', req.tenantId);
    cards.completed_jobs = (revCand || []).length;
    cards.open_quotes = (quoteCand || []).filter((j) => O.QUOTE_OPEN.has(j.status)).length;
    res.json({ success: true, data: { cards } });
  } catch (err) {
    log.error(`dashboard failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Enrollments (shared across all types) — the "Active Outreach" table
// ---------------------------------------------------------------------------
router.get('/enrollments', async (req, res) => {
  try {
    const db = getUserClient(req);
    let q = db.from('outreach_enrollments').select('*').eq('tenant_id', req.tenantId);
    if (req.query.type) q = q.eq('outreach_type', req.query.type);
    if (req.query.status) q = q.eq('status', req.query.status);
    const { data: enr, error } = await q.order('next_send_at', { ascending: true, nullsFirst: false }).limit(500);
    if (error) throw error;
    // latest message per enrollment for "last message" / "next step"
    const ids = (enr || []).map((e) => e.id);
    let msgs = [];
    if (ids.length) {
      const { data: m } = await db.from('outreach_messages').select('enrollment_id, step_index, channel, status, subject, body, sent_at, scheduled_for, created_at')
        .eq('tenant_id', req.tenantId).in('enrollment_id', ids).order('created_at', { ascending: false });
      msgs = m || [];
    }
    const lastByEnr = {}; const draftByEnr = {};
    for (const m of msgs) {
      if (!lastByEnr[m.enrollment_id] && m.status === 'sent') lastByEnr[m.enrollment_id] = m;
      if (m.status === 'draft' && (!draftByEnr[m.enrollment_id])) draftByEnr[m.enrollment_id] = m;
    }
    const rows = (enr || []).map((e) => ({
      ...e,
      total_steps: O.totalSteps(e),
      last_message: lastByEnr[e.id] || null,
      pending_draft: draftByEnr[e.id] || null,
    }));
    res.json({ success: true, data: rows });
  } catch (err) {
    log.error(`enrollments failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/enrollments/:id', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { data: enr, error } = await db.from('outreach_enrollments').select('*').eq('tenant_id', req.tenantId).eq('id', req.params.id).single();
    if (error || !enr) return res.status(404).json({ success: false, error: 'Not found' });
    const { data: msgs } = await db.from('outreach_messages').select('*').eq('tenant_id', req.tenantId).eq('enrollment_id', enr.id).order('step_index').order('created_at');
    res.json({ success: true, data: { enrollment: { ...enr, total_steps: O.totalSteps(enr) }, messages: msgs || [] } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Generate drafts for the current step (manual "prepare next touch")
router.post('/enrollments/:id/generate', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { data: enr } = await db.from('outreach_enrollments').select('*').eq('tenant_id', req.tenantId).eq('id', req.params.id).single();
    if (!enr) return res.status(404).json({ success: false, error: 'Not found' });
    const r = await O.createDraftsForStep(db, req.tenantId, enr);
    if (!r.ok) {
      if (r.missing) await db.from('outreach_enrollments').update({ status: 'missing_contact', updated_at: new Date().toISOString() }).eq('tenant_id', req.tenantId).eq('id', enr.id);
      return res.status(400).json({ success: false, error: r.reason || 'Could not build a draft', missing: r.missing });
    }
    await db.from('outreach_enrollments').update({ status: 'needs_review', updated_at: new Date().toISOString() }).eq('tenant_id', req.tenantId).eq('id', enr.id);
    res.json({ success: true, data: r.drafts });
  } catch (err) {
    log.error(`generate failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/enrollments/:id/:action(pause|resume|stop|skip|mark-replied)', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { data: enr } = await db.from('outreach_enrollments').select('*').eq('tenant_id', req.tenantId).eq('id', req.params.id).single();
    if (!enr) return res.status(404).json({ success: false, error: 'Not found' });
    let out;
    switch (req.params.action) {
      case 'pause': out = await O.pause(db, req.tenantId, enr.id, req.body.reason); break;
      case 'resume': out = await O.resume(db, req.tenantId, enr.id); break;
      case 'stop': out = await O.stop(db, req.tenantId, enr.id, req.body.reason); break;
      case 'skip': out = await O.skipNext(db, req.tenantId, enr); break;
      case 'mark-replied': out = await O.markReplied(db, req.tenantId, enr.id); break;
    }
    res.json({ success: true, data: out });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Approve + send all current-step drafts now, then advance the cadence.
router.post('/enrollments/:id/send-now', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { data: enr } = await db.from('outreach_enrollments').select('*').eq('tenant_id', req.tenantId).eq('id', req.params.id).single();
    if (!enr) return res.status(404).json({ success: false, error: 'Not found' });

    // ensure drafts exist for this step
    let { data: drafts } = await db.from('outreach_messages').select('*')
      .eq('tenant_id', req.tenantId).eq('enrollment_id', enr.id).eq('step_index', enr.current_step).eq('status', 'draft');
    if (!drafts || !drafts.length) {
      const built = await O.createDraftsForStep(db, req.tenantId, enr);
      if (!built.ok) return res.status(400).json({ success: false, error: built.reason || 'No contact channel available', missing: built.missing });
      drafts = built.drafts;
    }
    const tenant = await getTenant(req);
    const results = [];
    for (const m of drafts) { results.push(await O.sendOne(db, tenant, m)); }
    const anySent = results.some((r) => r.ok);
    let updated = enr;
    if (anySent) updated = await O.advanceAfterSend(db, req.tenantId, enr);
    res.json({ success: anySent, data: updated, results });
  } catch (err) {
    log.error(`send-now failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Edit a single draft message before sending
router.patch('/messages/:id', async (req, res) => {
  try {
    const db = getUserClient(req);
    const updates = { updated_at: new Date().toISOString() };
    if (req.body.subject !== undefined) updates.subject = req.body.subject;
    if (req.body.body !== undefined) updates.body = req.body.body;
    const { data, error } = await db.from('outreach_messages').update(updates)
      .eq('tenant_id', req.tenantId).eq('id', req.params.id).eq('status', 'draft').select().single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Send a single draft message (then advance if it was the last open draft of the step)
router.post('/messages/:id/send', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { data: msg } = await db.from('outreach_messages').select('*').eq('tenant_id', req.tenantId).eq('id', req.params.id).single();
    if (!msg) return res.status(404).json({ success: false, error: 'Not found' });
    const tenant = await getTenant(req);
    const r = await O.sendOne(db, tenant, msg);
    if (r.ok) {
      const { data: remaining } = await db.from('outreach_messages').select('id')
        .eq('tenant_id', req.tenantId).eq('enrollment_id', msg.enrollment_id).eq('step_index', msg.step_index).eq('status', 'draft');
      if (!remaining || !remaining.length) {
        const { data: enr } = await db.from('outreach_enrollments').select('*').eq('tenant_id', req.tenantId).eq('id', msg.enrollment_id).single();
        if (enr) await O.advanceAfterSend(db, req.tenantId, enr);
      }
    }
    res.status(r.ok ? 200 : 502).json({ success: r.ok, error: r.ok ? undefined : r.error });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// REVIEWS — candidates (completed jobs) + enroll
// ---------------------------------------------------------------------------
router.get('/reviews', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { data: enr } = await db.from('outreach_enrollments').select('*').eq('tenant_id', req.tenantId).eq('outreach_type', 'review').order('created_at', { ascending: false });
    // candidates: completed jobs whose customer is not already enrolled / not opted out
    const { data: jobs } = await db.from('jobs').select('id, customer_id, description, completed_date, status').eq('tenant_id', req.tenantId).eq('status', 'completed');
    const custIds = [...new Set((jobs || []).map((j) => j.customer_id).filter(Boolean))];
    let custs = [];
    if (custIds.length) {
      const { data: cs } = await db.from('customers').select('id, name, email, phone, service_type, last_job_date, do_not_ask_review, do_not_contact, unsubscribed').eq('tenant_id', req.tenantId).in('id', custIds);
      custs = cs || [];
    }
    const enrolledCust = new Set((enr || []).filter((e) => ['active', 'paused', 'needs_review', 'completed', 'missing_contact'].includes(e.status)).map((e) => e.customer_id).filter(Boolean));
    const candidates = custs.filter((c) => !enrolledCust.has(c.id) && !c.do_not_ask_review && !c.do_not_contact && !c.unsubscribed)
      .map((c) => ({ ...c, channel: [c.email && 'email', c.phone && 'text'].filter(Boolean).join(' + ') || 'no contact' }));
    res.json({ success: true, data: { enrollments: (enr || []).map((e) => ({ ...e, total_steps: O.totalSteps(e) })), candidates } });
  } catch (err) {
    log.error(`reviews failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/reviews/enroll', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { customer_id } = req.body || {};
    if (!customer_id) return res.status(400).json({ success: false, error: 'customer_id required' });
    const { data: c } = await db.from('customers').select('*').eq('tenant_id', req.tenantId).eq('id', customer_id).single();
    if (!c) return res.status(404).json({ success: false, error: 'Customer not found' });
    const textEligible = await O.canText(db, req.tenantId, { customer_id });
    const r = await O.createEnrollment(db, req.tenantId, {
      outreach_type: 'review', customer_id,
      contact_name: c.name, contact_email: c.email, contact_phone: c.phone,
      text_eligible: textEligible,
      status: (c.email || (c.phone && textEligible)) ? 'active' : 'missing_contact',
    });
    res.json({ success: true, data: r.enrollment, existed: r.existed });
  } catch (err) {
    log.error(`review enroll failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// QUOTES — open jobs + enroll into follow-up
// ---------------------------------------------------------------------------
router.get('/quotes', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { data: jobs } = await db.from('jobs').select('*').eq('tenant_id', req.tenantId).order('created_at', { ascending: false }).limit(500);
    const open = (jobs || []).filter((j) => O.QUOTE_OPEN.has(j.status));
    const custIds = [...new Set(open.map((j) => j.customer_id).filter(Boolean))];
    let custMap = {};
    if (custIds.length) {
      const { data: cs } = await db.from('customers').select('id, name, email, phone').eq('tenant_id', req.tenantId).in('id', custIds);
      (cs || []).forEach((c) => { custMap[c.id] = c; });
    }
    const { data: enr } = await db.from('outreach_enrollments').select('*').eq('tenant_id', req.tenantId).eq('outreach_type', 'quote');
    const enrByJob = {}; (enr || []).forEach((e) => { if (e.job_id) enrByJob[e.job_id] = e; });
    const rows = open.map((j) => ({
      ...j,
      customer_name: custMap[j.customer_id]?.name || null,
      customer_email: custMap[j.customer_id]?.email || null,
      customer_phone: custMap[j.customer_id]?.phone || null,
      enrollment: enrByJob[j.id] ? { ...enrByJob[j.id], total_steps: O.totalSteps(enrByJob[j.id]) } : null,
    }));
    res.json({ success: true, data: rows });
  } catch (err) {
    log.error(`quotes failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/quotes/enroll', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { job_id, cadence, cadence_days } = req.body || {};
    if (!job_id) return res.status(400).json({ success: false, error: 'job_id required' });
    const { data: job } = await db.from('jobs').select('*').eq('tenant_id', req.tenantId).eq('id', job_id).single();
    if (!job) return res.status(404).json({ success: false, error: 'Quote not found' });
    let contact = { name: null, email: null, phone: null };
    if (job.customer_id) {
      const { data: c } = await db.from('customers').select('name, email, phone').eq('tenant_id', req.tenantId).eq('id', job.customer_id).maybeSingle();
      if (c) contact = c;
    }
    const r = await O.createEnrollment(db, req.tenantId, {
      outreach_type: 'quote', job_id, customer_id: job.customer_id || null,
      contact_name: contact.name, contact_email: contact.email, contact_phone: contact.phone,
      cadence: cadence || 'standard', cadence_days: Array.isArray(cadence_days) ? cadence_days : null,
      text_eligible: false, // quotes are not completed jobs -> email only
      channel_pref: 'email',
      status: contact.email ? 'active' : 'missing_contact',
    });
    res.json({ success: true, data: r.enrollment, existed: r.existed });
  } catch (err) {
    log.error(`quote enroll failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// REFERRAL PARTNERS — list / add / edit / delete / enroll / find
// ---------------------------------------------------------------------------
function partnerRoutes(table, type) {
  router.get(`/${type}`, async (req, res) => {
    try {
      const db = getUserClient(req);
      const { data: rows } = await db.from(table).select('*').eq('tenant_id', req.tenantId).order('created_at', { ascending: false }).limit(500);
      const ids = (rows || []).map((r) => r.id);
      let enr = [];
      if (ids.length) {
        const col = type === 'referral_partners' ? 'referral_partner_id' : 'commercial_prospect_id';
        const { data: e } = await db.from('outreach_enrollments').select('*').eq('tenant_id', req.tenantId).in(col, ids);
        enr = e || [];
      }
      const enrBy = {}; enr.forEach((e) => { enrBy[e.referral_partner_id || e.commercial_prospect_id] = e; });
      res.json({ success: true, data: (rows || []).map((r) => ({ ...r, enrollment: enrBy[r.id] ? { ...enrBy[r.id], total_steps: O.totalSteps(enrBy[r.id]) } : null })) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.post(`/${type}`, async (req, res) => {
    try {
      const db = getUserClient(req);
      const b = req.body || {};
      const row = { tenant_id: req.tenantId };
      const cols = table === 'referral_partners'
        ? ['name', 'company', 'partner_type', 'email', 'phone', 'website', 'city', 'source_url', 'notes']
        : ['name', 'contact_person', 'prospect_type', 'email', 'phone', 'website', 'address', 'city', 'source_url', 'notes'];
      for (const c of cols) if (b[c] !== undefined) row[c] = b[c];
      const { data, error } = await db.from(table).insert(row).select().single();
      if (error) throw error;
      res.json({ success: true, data });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.patch(`/${type}/:id`, async (req, res) => {
    try {
      const db = getUserClient(req);
      const updates = { updated_at: new Date().toISOString() };
      const allow = ['name', 'company', 'contact_person', 'partner_type', 'prospect_type', 'email', 'phone', 'website', 'address', 'city', 'source_url', 'notes', 'outreach_status', 'do_not_contact', 'unsubscribed'];
      for (const k of allow) if (req.body[k] !== undefined) updates[k] = req.body[k];
      const { data, error } = await db.from(table).update(updates).eq('tenant_id', req.tenantId).eq('id', req.params.id).select().single();
      if (error) throw error;
      res.json({ success: true, data });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.delete(`/${type}/:id`, async (req, res) => {
    try {
      const db = getUserClient(req);
      const { error } = await db.from(table).delete().eq('tenant_id', req.tenantId).eq('id', req.params.id);
      if (error) throw error;
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Enroll a prospect into its email-only outreach cadence (Day 1 needs approval)
  router.post(`/${type}/:id/enroll`, async (req, res) => {
    try {
      const db = getUserClient(req);
      const { data: p } = await db.from(table).select('*').eq('tenant_id', req.tenantId).eq('id', req.params.id).single();
      if (!p) return res.status(404).json({ success: false, error: 'Not found' });
      if (p.do_not_contact || p.unsubscribed) return res.status(400).json({ success: false, error: 'This contact is opted out.' });
      const outreachType = table === 'referral_partners' ? 'referral_partner' : 'commercial';
      const fields = {
        outreach_type: outreachType,
        contact_name: p.name || p.contact_person, contact_email: p.email, contact_phone: p.phone,
        channel_pref: 'email', text_eligible: false,
        status: p.email ? 'active' : 'missing_contact',
      };
      if (table === 'referral_partners') fields.referral_partner_id = p.id; else fields.commercial_prospect_id = p.id;
      const r = await O.createEnrollment(db, req.tenantId, fields);
      await db.from(table).update({ outreach_status: 'drafted', updated_at: new Date().toISOString() }).eq('tenant_id', req.tenantId).eq('id', p.id);
      res.json({ success: true, data: r.enrollment, existed: r.existed });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Trigger the finder agent (Serper + Claude, service-area limited)
  router.post(`/${type}/find`, async (req, res) => {
    try {
      const agent = table === 'referral_partners' ? 'referral-partner-finder' : 'commercial-finder';
      const payload = { requested_by: 'owner' };
      if (table === 'referral_partners' && req.body.partner_type) payload.partner_type = req.body.partner_type;
      if (table === 'commercial_prospects' && req.body.prospect_type) payload.prospect_type = req.body.prospect_type;
      await enqueueJob(req.tenantId, agent, payload);
      res.json({ success: true, queued: true, message: 'Searching your service area — new prospects will appear here shortly.' });
    } catch (err) {
      log.error(`find failed: ${err.message}`);
      res.status(500).json({ success: false, error: err.message });
    }
  });
}
partnerRoutes('referral_partners', 'referral_partners');
partnerRoutes('commercial_prospects', 'commercial_prospects');

// ---------------------------------------------------------------------------
// TEMPLATES — list / edit (new version) / restore default / preview
// ---------------------------------------------------------------------------
router.get('/templates', async (req, res) => {
  try {
    const db = getUserClient(req);
    let q = db.from('outreach_templates').select('*').eq('tenant_id', req.tenantId).eq('active', true);
    if (req.query.type) q = q.eq('outreach_type', req.query.type);
    const { data } = await q.order('outreach_type').order('step_index').order('channel');
    // de-dupe to the highest-version active per (type,step,channel)
    const best = {};
    for (const t of (data || [])) {
      const k = `${t.outreach_type}|${t.step_index}|${t.channel}`;
      if (!best[k] || t.version > best[k].version) best[k] = t;
    }
    res.json({ success: true, data: Object.values(best) });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.put('/templates', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { outreach_type, step_index, channel, subject, body, label } = req.body || {};
    if (!outreach_type || !step_index || !channel || !body) return res.status(400).json({ success: false, error: 'type, step_index, channel, body required' });
    const { data: cur } = await db.from('outreach_templates').select('version, day_offset')
      .eq('tenant_id', req.tenantId).eq('outreach_type', outreach_type).eq('step_index', step_index).eq('channel', channel)
      .order('version', { ascending: false }).limit(1);
    const maxVer = cur && cur[0] ? cur[0].version : 0;
    const dayOffset = cur && cur[0] ? cur[0].day_offset : 0;
    // deactivate prior non-default versions; keep the is_default row for restore
    await db.from('outreach_templates').update({ active: false, updated_at: new Date().toISOString() })
      .eq('tenant_id', req.tenantId).eq('outreach_type', outreach_type).eq('step_index', step_index).eq('channel', channel).eq('is_default', false);
    await db.from('outreach_templates').update({ active: false })
      .eq('tenant_id', req.tenantId).eq('outreach_type', outreach_type).eq('step_index', step_index).eq('channel', channel).eq('is_default', true);
    const { data, error } = await db.from('outreach_templates').insert({
      tenant_id: req.tenantId, outreach_type, step_index, channel, day_offset: dayOffset,
      subject: subject || null, body, label: label || null, version: maxVer + 1, active: true, is_default: false, updated_by: 'owner',
    }).select().single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post('/templates/restore', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { outreach_type, step_index, channel } = req.body || {};
    await db.from('outreach_templates').update({ active: false, updated_at: new Date().toISOString() })
      .eq('tenant_id', req.tenantId).eq('outreach_type', outreach_type).eq('step_index', step_index).eq('channel', channel).eq('is_default', false);
    const { data, error } = await db.from('outreach_templates').update({ active: true })
      .eq('tenant_id', req.tenantId).eq('outreach_type', outreach_type).eq('step_index', step_index).eq('channel', channel).eq('is_default', true).select().single();
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// Render a preview of any template with sample data
router.get('/templates/preview', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { type, step, channel } = req.query;
    const tpl = await (async () => {
      const { data } = await db.from('outreach_templates').select('*').eq('tenant_id', req.tenantId)
        .eq('outreach_type', type).eq('step_index', step).eq('channel', channel).eq('active', true).order('version', { ascending: false }).limit(1);
      return data && data[0];
    })();
    if (!tpl) return res.status(404).json({ success: false, error: 'Template not found' });
    const cfg = await O.loadOutreachConfig(db, req.tenantId);
    const sampleEnr = { id: 'preview', outreach_type: type, contact_name: 'Jordan Smith', contact_email: 'jordan@example.com' };
    const vars = O.buildVars(sampleEnr, { service: 'tree removal', company: 'Coastal Realty', job_date: 'June 12, 2026', partner_context: O.partnerContext(req.query.partner_type || 'real_estate') });
    let out;
    if (channel === 'email') out = O.renderEmail(tpl.body, tpl.subject, vars, cfg.links, O.unsubUrl('preview'));
    else out = { subject: null, html: O.renderSms(tpl.body, vars, cfg.links) };
    res.json({ success: true, data: { subject: out.subject, body: out.html, label: tpl.label } });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ---------------------------------------------------------------------------
// SETTINGS — auto-send flags + recommended lead sources
// ---------------------------------------------------------------------------
router.get('/settings', async (req, res) => {
  try {
    const db = getUserClient(req);
    const keys = TYPES.map((t) => `outreach_autosend_${t}`).concat(['outreach_lead_sources']);
    const { data } = await db.from('tenant_config').select('key, value').eq('tenant_id', req.tenantId).in('key', keys);
    const cfg = {}; (data || []).forEach((r) => { cfg[r.key] = r.value; });
    const autosend = {}; TYPES.forEach((t) => { autosend[t] = cfg[`outreach_autosend_${t}`] === 'true' || cfg[`outreach_autosend_${t}`] === true; });
    let enabledSources = [];
    if (cfg.outreach_lead_sources) { try { enabledSources = JSON.parse(cfg.outreach_lead_sources); } catch (_) { /* ignore */ } }
    res.json({ success: true, data: { autosend, lead_sources: LEAD_SOURCES, enabled_sources: enabledSources } });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.put('/settings', async (req, res) => {
  try {
    const db = getUserClient(req);
    const ups = [];
    if (req.body.autosend && typeof req.body.autosend === 'object') {
      for (const t of TYPES) if (req.body.autosend[t] !== undefined) ups.push({ tenant_id: req.tenantId, key: `outreach_autosend_${t}`, value: String(!!req.body.autosend[t]) });
    }
    if (Array.isArray(req.body.enabled_sources)) ups.push({ tenant_id: req.tenantId, key: 'outreach_lead_sources', value: JSON.stringify(req.body.enabled_sources) });
    if (ups.length) { const { error } = await db.from('tenant_config').upsert(ups, { onConflict: 'tenant_id,key' }); if (error) throw error; }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

module.exports = router;
