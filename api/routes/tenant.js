/**
 * Growth OS — Tenant Self-View Routes
 *
 * V1 hardening (2026-05-24): 1,435 lines. V1.1 file-split plan:
 *   ./tenant/overview.js   — GET /overview
 *   ./tenant/pipeline.js   — pipeline CRUD
 *   ./tenant/clients.js    — clients + customers
 *   ./tenant/finance.js    — /finance read endpoints
 *   ./tenant/onboarding.js — onboarding-state + onboarding-step + onboarding-complete
 *   ./tenant/support.js    — support thread/message endpoints
 *   ./tenant/index.js      — mount each sub-router
 *
 * Every user who isn't Patrick hits these routes — they return the SAME
 * payload shape as /api/admin/* so the mobile app can consume both with
 * no screen changes, but scoped to the single logged-in tenant.
 *
 * This is production infrastructure: when a real client (e.g. a plumbing
 * shop) signs up and gets their own forked FGA app, their app calls these
 * endpoints. The demo tenant (Apex Plumbing, is_demo=true) is just the
 * first consumer.
 *
 * Route map (intentionally mirrors /api/admin/*):
 *   GET  /api/tenant/overview   — my dashboard
 *   GET  /api/tenant/pipeline   — my lead/estimate pipeline
 *   POST /api/tenant/pipeline   — add a new lead (write-guarded for demo)
 *   GET  /api/tenant/pipeline/:leadId
 *   PATCH/api/tenant/pipeline/:leadId
 *   GET  /api/tenant/clients    — my customers (end-customers, NOT sub-tenants)
 *   GET  /api/tenant/clients/:customerId — customer detail
 *   GET  /api/tenant/finance    — my income/expenses/profit
 */

const express = require('express');
const router = express.Router();
const { getServiceClient } = require('../../db/client');
const { getUserClient } = require('../../db/userClient');
const { createLogger } = require('../../core/logger');
const { FGA_TENANT_ID } = require('../../core/config');
const log = createLogger('tenant-api');

// ---------------------------------------------------------------------------
// GET /api/tenant/overview — Single-tenant business overview
// Matches /api/admin/overview shape so the mobile Overview screen works as-is:
//   { success, tenants: [SELF], totals: {...} }
// ---------------------------------------------------------------------------
router.get('/overview', async (req, res) => {
  try {
    const db = getUserClient(req);
    const tid = req.tenantId;

    const [leadsRes, contentRes, finRes] = await Promise.all([
      db.from('leads').select('id, status, created_at, final_revenue').eq('tenant_id', tid),
      db.from('content_drafts').select('id, status, created_at').eq('tenant_id', tid),
      db.from('finance_entries').select('entry_type, amount, date').eq('tenant_id', tid),
    ]);

    const leads = leadsRes.data || [];
    const content = contentRes.data || [];
    const finance = finRes.data || [];

    // Month-to-date revenue from finance_entries (income)
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const mtdRevenue = finance
      .filter((f) => f.entry_type === 'income' && new Date(f.date) >= monthStart)
      .reduce((sum, f) => sum + (parseFloat(f.amount) || 0), 0);

    // Year-to-date revenue
    const yearStart = new Date(now.getFullYear(), 0, 1);
    const ytdRevenue = finance
      .filter((f) => f.entry_type === 'income' && new Date(f.date) >= yearStart)
      .reduce((sum, f) => sum + (parseFloat(f.amount) || 0), 0);

    // Pipeline buckets — "open" = anything not yet completed or lost.
    // `won` (Job Sold) is still open work for a service business until
    // it's marked completed, so include it.
    const openLeads = leads.filter((l) => !['completed', 'lost'].includes(l.status)).length;
    const lostLeads = leads.filter((l) => l.status === 'lost').length;
    const activeLeads = leads.length - lostLeads;
    const wonThisMonth = leads.filter(
      (l) => l.status === 'won' || (l.status === 'completed' && l.final_revenue)
    ).length;

    res.json({
      success: true,
      // Shape mirrors admin/overview. The mobile app uses `totals` and treats
      // `tenants` as a list, so we return a single-element list.
      tenants: [
        {
          id: req.tenant.id,
          name: req.tenant.name,
          slug: req.tenant.slug,
          vertical: req.tenant.vertical,
          status: req.tenant.status,
          created_at: req.tenant.created_at,
          lead_count: leads.length,
          content_count: content.length,
          content_by_status: {
            draft: content.filter((c) => c.status === 'draft').length,
            approved: content.filter((c) => c.status === 'approved').length,
            posted: content.filter((c) => c.status === 'posted').length,
          },
          monthly_revenue: mtdRevenue,
          ytd_revenue: ytdRevenue,
          open_leads: openLeads,
          won_this_month: wonThisMonth,
        },
      ],
      totals: {
        total_tenants: 1,
        total_leads: leads.length,
        active_leads: activeLeads,
        lost_leads: lostLeads,
        total_content: content.length,
        // For service-business tenant, "mrr" is labeled differently on screens
        // that support verticals (useLabels.mrr_label). We keep the key for
        // compatibility but its semantic is "this month's revenue".
        mrr: mtdRevenue,
        ytd_revenue: ytdRevenue,
        open_leads: openLeads,
      },
      self: {
        id: req.tenant.id,
        name: req.tenant.name,
        vertical: req.tenant.vertical,
        is_demo: req.isDemo,
      },
    });
  } catch (err) {
    log.error(`Tenant overview failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/tenant/pipeline — This tenant's lead/estimate pipeline
// Matches /api/admin/pipeline shape.
// ---------------------------------------------------------------------------
router.get('/pipeline', async (req, res) => {
  try {
    const db = getUserClient(req);

    const { data: leads, error } = await db
      .from('leads')
      .select('*')
      .eq('tenant_id', req.tenantId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const pipeline = {};
    for (const lead of leads || []) {
      const status = lead.status || 'new_lead';
      pipeline[status] = (pipeline[status] || 0) + 1;
    }

    res.json({ success: true, pipeline, leads: leads || [] });
  } catch (err) {
    log.error(`Tenant pipeline failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/tenant/pipeline — Add a prospect/lead
// Guarded: demo tenants get a mocked success via demoWriteGuard middleware
// mounted above this route.
// ---------------------------------------------------------------------------
router.post('/pipeline', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { company_name, name, email, phone, service_type, city, lead_source, status, notes } = req.body;

    if (!company_name && !name) {
      return res.status(400).json({ success: false, error: 'Company name or contact name required' });
    }

    const { data: lead, error } = await db
      .from('leads')
      .insert({
        tenant_id: req.tenantId,
        company_name: company_name || '',
        name: name || '',
        email: email || '',
        phone: phone || '',
        service_type: service_type || '',
        city: city || '',
        lead_source: lead_source || 'manual',
        status: status || 'new_lead',
        notes: notes || '',
      })
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, lead });
  } catch (err) {
    log.error(`Tenant pipeline add failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/pipeline/:leadId', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { data: lead, error } = await db
      .from('leads')
      .select('*')
      .eq('id', req.params.leadId)
      .eq('tenant_id', req.tenantId)
      .single();
    if (error) throw error;
    if (!lead) return res.status(404).json({ success: false, error: 'Lead not found' });
    res.json({ success: true, lead });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.patch('/pipeline/:leadId', async (req, res) => {
  try {
    const db = getUserClient(req);
    const allowed = ['status', 'company_name', 'name', 'email', 'phone', 'service_type', 'city', 'lead_source', 'notes', 'priority_tier', 'lead_score'];
    const updates = {};
    for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k];
    if (!Object.keys(updates).length) return res.status(400).json({ success: false, error: 'No fields to update' });

    const { data: lead, error } = await db
      .from('leads')
      .update(updates)
      .eq('id', req.params.leadId)
      .eq('tenant_id', req.tenantId)
      .select()
      .single();
    if (error) throw error;
    res.json({ success: true, lead });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Outreach approval workflow — tenant-scoped mirror of the /api/admin
// endpoints. Lets a tenant_owner (real client, plus the demo account) review
// and approve each cold-outreach draft on their lead-detail screen, instead
// of letting the agent send autonomously. The screen renders identically;
// the request is just scoped to req.tenantId rather than the FGA tenant id.
//
// For the demo tenant, sendEmail short-circuits via demo-guard so no real
// outbound emails fire — the UI still walks through the approval gesture.
// ---------------------------------------------------------------------------

router.get('/pipeline/:leadId/outreach', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { leadId } = req.params;

    const { data: sequences, error: seqErr } = await db
      .from('outreach_sequences')
      .select('id, sequence_status, sequence_type, message_subject, message_body, created_at, contact_id')
      .eq('lead_id', leadId)
      .eq('tenant_id', req.tenantId)
      .order('created_at', { ascending: false })
      .limit(1);
    if (seqErr) throw seqErr;

    const sequence = sequences && sequences[0] ? sequences[0] : null;

    let conversation = null;
    if (sequence) {
      const { data: convs } = await db
        .from('conversations')
        .select('id, channel, direction, message_subject, message_body, metadata, created_at')
        .eq('tenant_id', req.tenantId)
        .eq('lead_id', leadId)
        .eq('sequence_id', sequence.id)
        .order('created_at', { ascending: false })
        .limit(1);
      conversation = convs && convs[0] ? convs[0] : null;
    }

    res.json({ success: true, sequence, conversation });
  } catch (err) {
    log.error(`Tenant outreach fetch failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/pipeline/:leadId/outreach/approve', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { leadId } = req.params;
    const { sequence_id } = req.body || {};
    if (!sequence_id) {
      return res.status(400).json({ success: false, error: 'sequence_id is required' });
    }

    const { data: sequence, error: seqErr } = await db
      .from('outreach_sequences')
      .select('*')
      .eq('id', sequence_id)
      .eq('tenant_id', req.tenantId)
      .single();
    if (seqErr || !sequence) {
      return res.status(404).json({ success: false, error: 'Sequence not found' });
    }
    if (sequence.sequence_status !== 'draft') {
      return res.status(400).json({ success: false, error: `Sequence is already ${sequence.sequence_status}` });
    }

    let sendResult = null;
    let contactEmail = null;
    if (sequence.sequence_type === 'email') {
      const { data: contact } = await db
        .from('contacts')
        .select('email, first_name, last_name')
        .eq('id', sequence.contact_id)
        .single();
      const toEmail = contact?.email;
      if (!toEmail) {
        return res.status(400).json({ success: false, error: 'Contact has no email address' });
      }
      contactEmail = toEmail;
      const { data: conv } = await db
        .from('conversations')
        .select('metadata, message_body')
        .eq('sequence_id', sequence.id)
        .order('created_at', { ascending: false })
        .limit(1);
      const htmlBody = conv && conv[0]?.metadata?.body_html
        ? conv[0].metadata.body_html
        : `<p>${(sequence.message_body || '').replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>')}</p>`;

      // Pass req.tenant so demo-guard short-circuits real sends for the
      // demo tenant. The endpoint still returns success so the UI walks
      // through the approval flow visually.
      const { sendEmail } = require('../../integrations/email');
      try {
        sendResult = await sendEmail(toEmail, sequence.message_subject, htmlBody, {
          tenant: req.tenant || { id: req.tenantId },
          audience: 'customer',
          ownership: { sequence: { tenant_id: req.tenantId } },
        });
      } catch (sendErr) {
        log.error(`Tenant outreach approve send failed: ${sendErr.message}`);
        return res.status(500).json({ success: false, error: `Send failed: ${sendErr.message}` });
      }
    }

    const isEmailSend = sequence.sequence_type === 'email';
    const sentAt = new Date().toISOString();

    // outreach_sequences has no sent_at column — the send time lives in
    // metadata.sent_at (mirrors the admin send path). Writing a top-level
    // sent_at key here was a no-op/error before, which is why mobile-app
    // sends recorded no reliable send time. Spread existing metadata + bump
    // updated_at so the drip migration can derive Campaign Day 1 from this row.
    await db.from('outreach_sequences')
      .update({
        sequence_status: isEmailSend ? 'sent' : 'approved',
        updated_at: sentAt,
        metadata: isEmailSend
          ? { ...(sequence.metadata || {}), sent_at: sentAt }
          : (sequence.metadata || {}),
      })
      .eq('id', sequence_id)
      .eq('tenant_id', req.tenantId);

    await db.from('conversations')
      .update({
        metadata: {
          draft_status: isEmailSend ? 'sent' : 'approved',
          sent_at: sentAt,
          send_result: sendResult || null,
          sent_via: 'mobile',
        },
      })
      .eq('tenant_id', req.tenantId)
      .eq('sequence_id', sequence_id);

    await db.from('leads')
      .update({ lifecycle_stage: 'sequenced', status: 'contacted' })
      .eq('id', leadId)
      .eq('tenant_id', req.tenantId);

    // Log the send + enroll in the drip campaign — the admin/web send path
    // (sendEmailOutreachSequence) already does both; the mobile-app approve
    // route did neither, so FGA outreach approved from the phone never wrote
    // an outreach_sent activity row and was never picked up for follow-ups.
    // FGA-only: drip_enrollments + the activity_log convention are platform-
    // owner concepts, and enrollLead is a safe no-op without an active
    // campaign anyway. Use the service client so RLS doesn't block the writes.
    if (isEmailSend && req.tenantId === FGA_TENANT_ID) {
      const svc = getServiceClient();
      try {
        await svc.from('activity_log').insert({
          tenant_id: FGA_TENANT_ID,
          agent: 'admin',
          action: 'outreach_sent',
          entity_type: 'lead',
          entity_id: leadId,
          level: 'info',
          metadata: {
            sequence_id,
            channel: 'email',
            recipient: contactEmail || null,
            subject: sequence.message_subject || null,
            provider_id: sendResult?.id || null,
            sent_via: 'mobile',
            sent_at: sentAt,
          },
        });
      } catch (logErr) {
        log.warn(`activity_log outreach_sent write failed (mobile): ${logErr.message}`);
      }
      try {
        const { enrollLead } = require('../../core/drip-campaign');
        const { data: leadRow } = await svc
          .from('leads').select('*').eq('id', leadId).eq('tenant_id', FGA_TENANT_ID).maybeSingle();
        const enrollResult = await enrollLead(svc, {
          leadId,
          email: contactEmail,
          day1At: sentAt,
          enrolledBy: 'mobile',
          tenant: req.tenant || { id: FGA_TENANT_ID },
          lead: leadRow || null,
        });
        if (enrollResult?.enrolled) {
          log.info(`Drip enrollment created for lead ${leadId} (mobile send, day 1 = ${sentAt})`);
        }
      } catch (dripErr) {
        log.warn(`Drip enrollment skipped for lead ${leadId} (mobile): ${dripErr.message}`);
      }
    }

    res.json({ success: true, channel: sequence.sequence_type, send_result: sendResult });
  } catch (err) {
    log.error(`Tenant outreach approve failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/pipeline/:leadId/outreach/reject', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { leadId } = req.params;
    const { sequence_id, reason, regenerate } = req.body || {};
    if (!sequence_id) {
      return res.status(400).json({ success: false, error: 'sequence_id is required' });
    }

    // Default to regenerate=true for backward compatibility with older
    // mobile clients that omit the flag. Pass regenerate=false to do a
    // terminal reject (no new draft will be queued).
    const shouldRegenerate = regenerate !== false;
    const trimmedReason = (reason || '').trim();

    await db.from('outreach_sequences')
      .update({ sequence_status: 'rejected' })
      .eq('id', sequence_id)
      .eq('tenant_id', req.tenantId);

    await db.from('conversations')
      .update({
        metadata: {
          draft_status: 'rejected',
          rejected_at: new Date().toISOString(),
          reject_reason: trimmedReason || null,
          regenerated: shouldRegenerate,
        },
      })
      .eq('tenant_id', req.tenantId)
      .eq('sequence_id', sequence_id);

    // Terminal reject moves the lead off the enrichment path so the
    // outreach agent doesn't pick it back up on the next sweep.
    await db.from('leads')
      .update({ lifecycle_stage: shouldRegenerate ? 'enriched' : 'unqualified' })
      .eq('id', leadId)
      .eq('tenant_id', req.tenantId);

    // Only queue a regen when the caller asked for one.
    let regeneratedJobId = null;
    if (shouldRegenerate) {
      const { data: job, error: jobErr } = await db.from('agent_jobs').insert({
        tenant_id: req.tenantId,
        agent_name: 'outreach',
        payload: {
          lead_id: leadId,
          regenerate_feedback: trimmedReason || null,
          rejected_sequence_id: sequence_id,
        },
        status: 'pending',
      }).select('id').single();
      if (jobErr) {
        log.warn(`Tenant outreach regen queue failed: ${jobErr.message}`);
      } else {
        regeneratedJobId = job.id;
      }
    }

    res.json({ success: true, regenerate_job_id: regeneratedJobId, regenerated: shouldRegenerate });
  } catch (err) {
    log.error(`Tenant outreach reject failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/tenant/clients — THIS tenant's end-customers (NOT sub-tenants)
// Matches /api/admin/clients shape so the Accounts screen renders with no change.
// Source: contacts table filtered to contact_type='customer' + completed jobs.
// ---------------------------------------------------------------------------
router.get('/clients', async (req, res) => {
  try {
    const db = getUserClient(req);

    // Customers = contacts tied to this tenant with contact_type='customer'
    // or with a lead_id pointing to a won/completed lead.
    const { data: contacts, error: contactErr } = await db
      .from('contacts')
      .select('id, lead_id, name, email, phone, contact_type, outreach_status, created_at')
      .eq('tenant_id', req.tenantId)
      .in('contact_type', ['customer', 'lead', null]);

    if (contactErr) throw contactErr;

    // Pull ALL leads for the tenant so we can count repeat jobs per customer
    // (by matching on phone — same customer can have multiple leads for
    // different service calls over time). This is how a real service business
    // sees "Sarah Mitchell — 3 jobs" instead of 3 separate Sarah entries.
    const { data: allLeads } = await db
      .from('leads')
      .select('id, name, phone, email, status, final_revenue, service_type, city, updated_at, created_at')
      .eq('tenant_id', req.tenantId);

    // Index leads by normalized phone (primary) or email (fallback) so we
    // can attribute multiple leads to the same customer contact.
    const leadsByKey = new Map();
    const normalizePhone = (p) => (p ? String(p).replace(/\D+/g, '') : '');
    for (const l of allLeads || []) {
      const key = normalizePhone(l.phone) || (l.email || '').toLowerCase();
      if (!key) continue;
      if (!leadsByKey.has(key)) leadsByKey.set(key, []);
      leadsByKey.get(key).push(l);
    }

    // De-duplicate customer contacts by phone/email — when the seed creates
    // multiple leads with the same phone, they should collapse to a SINGLE
    // customer card with a lead_count of N.
    const uniqueByKey = new Map();
    for (const c of contacts || []) {
      if (c.contact_type !== 'customer') continue;
      const key = normalizePhone(c.phone) || (c.email || '').toLowerCase();
      if (!key) continue;
      // Keep the earliest-created contact (stable id for navigation)
      if (!uniqueByKey.has(key)) uniqueByKey.set(key, c);
    }

    const clients = [];
    for (const [key, contact] of uniqueByKey.entries()) {
      const leads = (leadsByKey.get(key) || []).sort((a, b) =>
        new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0)
      );
      const lifetimeRevenue = leads.reduce((sum, l) => sum + (parseFloat(l.final_revenue) || 0), 0);
      const jobCount = leads.filter((l) => l.status === 'completed' || l.status === 'won').length;
      const latest = leads[0] || null;
      const lastActivity = latest?.updated_at || latest?.created_at || contact.created_at;

      let health = 'yellow';
      if (lastActivity) {
        const days = (Date.now() - new Date(lastActivity).getTime()) / (1000 * 60 * 60 * 24);
        if (days <= 30) health = 'green';
        else if (days <= 90) health = 'yellow';
        else health = 'red';
      }

      clients.push({
        id: contact.id,
        name: contact.name,
        email: contact.email,
        phone: contact.phone,
        contact_type: contact.contact_type,
        service_type: latest?.service_type || null,
        city: latest?.city || null,
        lifetime_revenue: lifetimeRevenue,
        last_status: latest?.status || null,
        last_activity: lastActivity,
        health,
        // Shared shape with the admin clients endpoint so the mobile screen
        // doesn't need to branch on data shape.
        tier: 'customer',
        business_name: contact.name,
        lead_count: jobCount,   // jobs for this customer (now reflects repeat work)
        content_count: 0,
      });
    }

    // Sort by lifetime revenue desc so the most valuable customers surface first
    clients.sort((a, b) => (b.lifetime_revenue || 0) - (a.lifetime_revenue || 0));

    res.json({ success: true, clients });
  } catch (err) {
    log.error(`Tenant clients failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/tenant/clients — Tenant adds a new end-customer manually.
// Writes to the `contacts` table with contact_type='customer' so the
// existing GET /api/tenant/clients path picks it up on next reload.
// Idempotent by (tenant_id, phone): if a customer with the same phone
// already exists for this tenant, we return the existing row instead
// of erroring or creating a duplicate.
//
// 2026-05-26: First route switched from getServiceClient() to
// getUserClient(req). RLS policies from migrations 035 + 036 enforce
// tenant_id isolation at the database — even if this handler forgot
// to set tenant_id on the insert, Postgres would refuse the row.
// `req.tenantId` from tenantOwnerMiddleware is kept as a fast-fail at
// the application layer (returns 400 before talking to the DB if
// somehow null). Belt + suspenders.
// ---------------------------------------------------------------------------
router.post('/clients', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { name, email, phone, service_type, city, notes } = req.body || {};

    if (!name || !String(name).trim()) {
      return res.status(400).json({ success: false, error: 'Name is required' });
    }

    const normalizedPhone = phone ? String(phone).trim() : null;
    const normalizedEmail = email ? String(email).trim().toLowerCase() : null;

    // De-dupe: if a customer with the same phone (or email if no phone)
    // already exists for this tenant, return it instead of inserting again.
    if (normalizedPhone || normalizedEmail) {
      const dupQ = db
        .from('contacts')
        .select('*')
        .eq('tenant_id', req.tenantId)
        .eq('contact_type', 'customer');
      const filter = normalizedPhone
        ? dupQ.eq('phone', normalizedPhone)
        : dupQ.eq('email', normalizedEmail);
      const { data: existing } = await filter.maybeSingle();
      if (existing) {
        return res.status(200).json({ success: true, data: existing, deduped: true });
      }
    }

    const { data, error } = await db
      .from('contacts')
      .insert({
        tenant_id: req.tenantId,
        name: String(name).trim(),
        email: normalizedEmail,
        phone: normalizedPhone,
        contact_type: 'customer',
        outreach_status: 'active',
        metadata: {
          service_type: service_type || null,
          city: city || null,
          notes: notes || null,
        },
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ success: true, data });
  } catch (err) {
    log.error(`Tenant client create failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/tenant/clients/:customerId — Single customer detail
router.get('/clients/:customerId', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { customerId } = req.params;

    const [contactRes, messagesRes] = await Promise.all([
      db.from('contacts').select('*').eq('id', customerId).eq('tenant_id', req.tenantId).single(),
      db.from('messages').select('*').eq('contact_id', customerId).eq('tenant_id', req.tenantId).order('sent_at', { ascending: false }).limit(20),
    ]);

    if (contactRes.error) throw contactRes.error;
    if (!contactRes.data) return res.status(404).json({ success: false, error: 'Customer not found' });

    const contact = contactRes.data;
    let lead = null;
    if (contact.lead_id) {
      const { data } = await db.from('leads').select('*').eq('id', contact.lead_id).single();
      lead = data;
    }

    res.json({
      success: true,
      customer: contact,
      lead,
      messages: messagesRes.data || [],
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/tenant/finance — Service-business P&L for THIS tenant
// Mirrors /api/admin/finance payload but sourced from the single tenant's
// finance_entries. No MRR/subscription concept — service revenue is per-job.
// ---------------------------------------------------------------------------
router.get('/finance', async (req, res) => {
  try {
    const db = getUserClient(req);
    const tid = req.tenantId;

    const { data: entries, error } = await db
      .from('finance_entries')
      .select('entry_type, amount, date, category, description, recurring')
      .eq('tenant_id', tid)
      .order('date', { ascending: false });

    if (error) throw error;

    const all = entries || [];
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const yearStart = new Date(now.getFullYear(), 0, 1);

    // Monthly breakdown for the current year (keyed 1..12)
    const monthly = {};
    for (let m = 1; m <= 12; m++) monthly[m] = { income: 0, expenses: 0, net: 0 };

    let mtdIncome = 0, mtdExpenses = 0;
    let ytdIncome = 0, ytdExpenses = 0;
    const incomeByCategory = {};
    const expensesByCategory = {};

    for (const e of all) {
      const amt = parseFloat(e.amount) || 0;
      const d = new Date(e.date);
      const month = d.getMonth() + 1;
      const inYear = d >= yearStart && d <= now;
      const inMonth = d >= monthStart && d <= now;

      if (e.entry_type === 'income') {
        if (inYear) { ytdIncome += amt; monthly[month].income += amt; }
        if (inMonth) mtdIncome += amt;
        const cat = e.category || 'Uncategorized';
        incomeByCategory[cat] = (incomeByCategory[cat] || 0) + (inYear ? amt : 0);
      } else {
        if (inYear) { ytdExpenses += amt; monthly[month].expenses += amt; }
        if (inMonth) mtdExpenses += amt;
        const cat = e.category || 'Uncategorized';
        expensesByCategory[cat] = (expensesByCategory[cat] || 0) + (inYear ? amt : 0);
      }
    }
    for (let m = 1; m <= 12; m++) monthly[m].net = monthly[m].income - monthly[m].expenses;

    const ytdNet = ytdIncome - ytdExpenses;
    const mtdNet = mtdIncome - mtdExpenses;

    res.json({
      success: true,
      // Service-business shape. The mobile Finance screen reads these names
      // already via the month-by-month drill-in I shipped in 1.0.1.
      mrr: mtdIncome,                  // "This month revenue" for service vertical
      arr: ytdIncome,                  // YTD income (labeled appropriately on the screen)
      tenant_count: 0,                 // N/A for tenant self-view — no sub-tenants
      by_tier: { growth: 0, scale: 0 },// N/A
      clients: [],                     // N/A — the Accounts tab has its own endpoint
      setup_fees: { total: 0, paid: 0, outstanding: 0 }, // N/A
      // Service-business specific fields the tenant screens will read
      ytd: {
        income: ytdIncome,
        expenses: ytdExpenses,
        net: ytdNet,
        profit_margin: ytdIncome > 0 ? Math.round((ytdNet / ytdIncome) * 100) : 0,
      },
      mtd: { income: mtdIncome, expenses: mtdExpenses, net: mtdNet },
      monthly_breakdown: monthly,
      income_by_category: incomeByCategory,
      expenses_by_category: expensesByCategory,
      revenue_history: [],
    });
  } catch (err) {
    log.error(`Tenant finance failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/tenant/content — This tenant's content queue
// Mirrors a simple content list. Mobile uses this if a tenant content screen
// is ever added; for now it's available for future use.
router.get('/content', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { data: drafts, error } = await db
      .from('content_drafts')
      .select('*')
      .eq('tenant_id', req.tenantId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ success: true, drafts: drafts || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/tenant/web-chats — Inbox for AI Chat Agent sessions
//
// Mirrors /api/admin/web-chats but tenant-scoped. Returns inbound web_chat
// conversations from this tenant's marketing site (or wherever the chat
// widget is embedded) grouped by visitor session.
//
// Query params:
//   limit — default 100, max 500
//   days  — default 30
//   include_lead_attached — 'true' to include chats that DID convert to leads
// ---------------------------------------------------------------------------
router.get('/web-chats', async (req, res) => {
  try {
    const db = getUserClient(req);
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const days = Math.min(Number(req.query.days) || 30, 365);
    const includeAttached = String(req.query.include_lead_attached || 'false') === 'true';
    const sinceIso = new Date(Date.now() - days * 86400000).toISOString();

    let q = db.from('conversations')
      .select('id, lead_id, channel, direction, message_body, metadata, created_at')
      .eq('tenant_id', req.tenantId)
      .eq('direction', 'inbound')
      .eq('channel', 'web_chat')
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (!includeAttached) {
      q = q.is('lead_id', null);
    }
    const { data: rows, error } = await q;
    if (error) throw error;

    // Cluster by session_id (or message-id fallback) so a multi-message
    // conversation renders as a single card.
    const sessions = [];
    const sessionMap = new Map();
    for (const row of (rows || [])) {
      const sid = (row.metadata && row.metadata.session_id) || `noid-${row.id}`;
      if (!sessionMap.has(sid)) {
        const sess = {
          session_id: sid,
          messages: [],
          first_at: row.created_at,
          last_at: row.created_at,
          lead_id: row.lead_id,
        };
        sessionMap.set(sid, sess);
        sessions.push(sess);
      }
      const sess = sessionMap.get(sid);
      sess.messages.push({
        id: row.id,
        body: row.message_body,
        created_at: row.created_at,
        metadata: row.metadata || {},
      });
      if (row.created_at < sess.first_at) sess.first_at = row.created_at;
      if (row.created_at > sess.last_at) sess.last_at = row.created_at;
    }
    for (const s of sessions) s.messages.reverse();

    res.json({ success: true, sessions, total_messages: (rows || []).length });
  } catch (err) {
    log.error(`Tenant web-chats failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/tenant/self — Who am I? Used by the mobile app on login to
// resolve role + tenant info without a separate Supabase roundtrip.
router.get('/self', async (req, res) => {
  res.json({
    success: true,
    tenant: req.tenant,
    is_demo: req.isDemo,
  });
});

// ===========================================================================
// Onboarding Wizard Endpoints
//
// Both the mobile app's OnboardingWizardScreen and the web portal's
// OnboardingPortal use these endpoints. They're the source of truth for
// which steps a tenant sees, what's been captured so far, and what step
// to render next. Per docs/business/onboarding/onboarding-wizard-flow.md.
// ===========================================================================

const { resolveApplicableSteps, nextStep } = require('../../core/onboarding-step-resolver');

/**
 * Load this tenant's enabled modules + already-captured config into a
 * tidy object. Used by all the wizard endpoints below.
 */
async function loadOnboardingContext(db, tenantId) {
  const [modulesRes, configRes] = await Promise.all([
    db.from('tenant_modules').select('module, enabled').eq('tenant_id', tenantId).eq('enabled', true),
    db.from('tenant_config').select('key, value').eq('tenant_id', tenantId),
  ]);
  const enabledModuleKeys = (modulesRes.data || []).map((r) => r.module);
  const config = {};
  for (const row of configRes.data || []) {
    // tenant_config.value is JSONB; if a string was stored it may still
    // come back as a JSON-encoded scalar. Normalize to plain values for
    // the wizard's consumption.
    config[row.key] = row.value;
  }
  return { enabledModuleKeys, config };
}

/**
 * GET /api/tenant/onboarding-state
 *
 * Returns the module-filtered list of applicable steps, which step to
 * resume at, and any data already captured. Both wizard surfaces call
 * this on mount.
 */
router.get('/onboarding-state', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { enabledModuleKeys, config } = await loadOnboardingContext(db, req.tenantId);

    const deliveryPath = config.delivery_path || null;
    const applicable_steps = resolveApplicableSteps(enabledModuleKeys, deliveryPath);
    const completed = Array.isArray(config.onboarding_steps_completed)
      ? config.onboarding_steps_completed
      : [];
    const current = nextStep(applicable_steps, completed) || 'complete';
    const stage = config.onboarding_stage || 'not_started';

    res.json({
      success: true,
      status: req.tenant?.status || 'onboarding',
      stage,
      applicable_steps,
      steps_completed: completed,
      current_step: current,
      captured_data: config,
      modules_enabled: enabledModuleKeys,
    });
  } catch (err) {
    log.error(`onboarding-state failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/tenant/onboarding-step
 *
 * Save one completed wizard step. Body:
 *   { step: 'business_basics', data: { business_name, owner_name, ... } }
 *
 * The handler writes each data key as its own tenant_config row,
 * appends the step key to onboarding_steps_completed, and returns the
 * next step.
 */
router.post('/onboarding-step', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { step, data } = req.body || {};
    if (!step || typeof step !== 'string') {
      return res.status(400).json({ success: false, error: 'step (string) is required' });
    }
    const stepData = data && typeof data === 'object' ? data : {};

    // Upsert each captured field into tenant_config as its own row.
    // tenant_config.value is JSONB so we can store strings, arrays, objects
    // uniformly.
    const upserts = Object.entries(stepData).map(([key, value]) => ({
      tenant_id: req.tenantId,
      key,
      value, // JSONB column accepts anything JSON-serializable
    }));

    if (upserts.length) {
      const { error: upErr } = await db
        .from('tenant_config')
        .upsert(upserts, { onConflict: 'tenant_id,key' });
      if (upErr) throw upErr;
    }

    // Append the step key to the completed list (read-modify-write
    // because tenant_config is a kv store with JSONB values).
    const { data: existingRow } = await db
      .from('tenant_config')
      .select('value')
      .eq('tenant_id', req.tenantId)
      .eq('key', 'onboarding_steps_completed')
      .maybeSingle();
    const existing = Array.isArray(existingRow?.value) ? existingRow.value : [];
    const completed = existing.includes(step) ? existing : [...existing, step];

    await db.from('tenant_config').upsert(
      [
        { tenant_id: req.tenantId, key: 'onboarding_steps_completed', value: completed },
        { tenant_id: req.tenantId, key: 'onboarding_stage', value: step === 'complete' ? 'in_app_intake_complete' : 'in_app_intake_in_progress' },
      ],
      { onConflict: 'tenant_id,key' }
    );

    // Recompute applicable steps after the save — the delivery_path
    // (Step 3) may have just been chosen, which changes whether
    // apple_details (Step 3a) is shown.
    const { enabledModuleKeys, config } = await loadOnboardingContext(db, req.tenantId);
    const applicable_steps = resolveApplicableSteps(enabledModuleKeys, config.delivery_path || null);
    const next = nextStep(applicable_steps, completed) || 'complete';

    // Side effect: when path_choice lands as `owned`, fire the Day-1
    // Apple Developer enrollment email. Idempotent — only fires if
    // `apple_enrollment_email_sent_at` isn't already set.
    if (step === 'path_choice' && stepData.delivery_path === 'owned' && !config.apple_enrollment_email_sent_at) {
      try {
        const { sendAppleEnrollmentEmail } = require('../../core/apple-enrollment-email');
        await sendAppleEnrollmentEmail(db, {
          tenantId: req.tenantId,
          email: config.owner_email || req.user?.email,
          ownerName: config.owner_name,
          businessName: config.business_name || req.tenant?.name,
        });
        await db.from('tenant_config').upsert(
          { tenant_id: req.tenantId, key: 'apple_enrollment_email_sent_at', value: new Date().toISOString() },
          { onConflict: 'tenant_id,key' }
        );
      } catch (eErr) {
        log.warn(`Path-B enrollment email failed (non-fatal): ${eErr.message}`);
      }
    }

    // Log step completion for wizard analytics (fire-and-forget)
    db.from('activity_log').insert({
      tenant_id: req.tenantId,
      agent: 'onboarding_wizard',
      action: 'step_completed',
      details: { step, step_index: applicable_steps.indexOf(step), total_steps: applicable_steps.length },
    }).then(() => {}).catch(() => {});

    res.json({
      success: true,
      next_step: next,
      stage: step === 'complete' ? 'in_app_intake_complete' : 'in_app_intake_in_progress',
      applicable_steps,
      steps_completed: completed,
    });
  } catch (err) {
    log.error(`onboarding-step failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/tenant/onboarding-complete
 *
 * Signals that the customer has reached the final step. Verifies all
 * applicable steps are completed, flips the stage marker, and queues
 * the post-intake automation (asset-gen pipeline for the branded app).
 */
router.post('/onboarding-complete', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { enabledModuleKeys, config } = await loadOnboardingContext(db, req.tenantId);
    const applicable = resolveApplicableSteps(enabledModuleKeys, config.delivery_path || null);
    const completed = Array.isArray(config.onboarding_steps_completed)
      ? config.onboarding_steps_completed
      : [];

    // Allow `complete` to be missing in the completed list — we add it now.
    const missing = applicable.filter((s) => s !== 'complete' && !completed.includes(s));
    if (missing.length) {
      return res.status(400).json({
        success: false,
        error: 'Some required steps are not finished',
        missing_steps: missing,
      });
    }

    const finalCompleted = completed.includes('complete') ? completed : [...completed, 'complete'];
    await db.from('tenant_config').upsert(
      [
        { tenant_id: req.tenantId, key: 'onboarding_steps_completed', value: finalCompleted },
        { tenant_id: req.tenantId, key: 'onboarding_stage', value: 'in_app_intake_complete' },
        { tenant_id: req.tenantId, key: 'onboarding_intake_completed_at', value: new Date().toISOString() },
      ],
      { onConflict: 'tenant_id,key' }
    );

    // Flip the tenants.status so downstream workers know intake is in.
    await db.from('tenants').update({ status: 'onboarding_intake_complete' }).eq('id', req.tenantId);

    // Queue the asset-gen pipeline. The worker picks this up and runs
    // scripts/app-pipeline/generate-app-assets.js for this tenant —
    // icon + listing copy first, branded-app build steps next.
    // Non-fatal: log on failure so the wizard always returns success.
    try {
      await db.from('agent_jobs').insert({
        tenant_id: req.tenantId,
        agent_name: 'app-asset-pipeline',
        status: 'pending',
        priority: 5,
        payload: {
          trigger: 'onboarding_intake_complete',
          delivery_path: config.delivery_path || 'managed',
          tenant_slug: req.tenant?.slug,
        },
      });
      log.info(`Queued app-asset-pipeline job for tenant ${req.tenantId}`);
    } catch (qErr) {
      log.warn(`Could not queue asset-gen pipeline: ${qErr.message}`);
    }

    // Queue the DFY website build if the website module is enabled.
    if (enabledModuleKeys.includes('website')) {
      try {
        await db.from('agent_jobs').insert({
          tenant_id: req.tenantId,
          agent_name: 'dfy-website-build',
          status: 'pending',
          priority: 4,
          payload: {
            trigger: 'onboarding_intake_complete',
            tenant_slug: req.tenant?.slug,
          },
        });
        log.info(`Queued dfy-website-build job for tenant ${req.tenantId}`);
      } catch (qErr) {
        log.warn(`Could not queue website build: ${qErr.message}`);
      }
    }

    log.info(`Onboarding intake complete for tenant ${req.tenantId}`);
    res.json({ success: true, stage: 'in_app_intake_complete' });
  } catch (err) {
    log.error(`onboarding-complete failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/tenant/upload-asset
 *
 * Multipart upload for logo + photo seed images. Stored to Supabase
 * Storage bucket `tenant-assets` under `<tenant_slug>/<asset_type>/<filename>`.
 *
 * Request body (multipart):
 *   - file: the image
 *   - asset_type: 'logo' | 'photo_seed'
 *
 * Response: { success, url, asset_type }
 */
const multer = require('multer');
// Upload limit covers both photos (small) and video clips for the
// "+ Request Post" content flow. 50 MB comfortably holds 30-45s of
// 1080p iPhone footage. Images are tiny in comparison.
const uploadHandler = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
});

// Asset-type allowlist. logo + photo_seed are persistent brand assets
// stored on tenant_config. post_media_* are one-off uploads attached
// to a single content draft — we do NOT append them to any shared
// tenant_config array; the caller wires the returned URL into
// /api/content/generate.
const PERSISTENT_ASSET_TYPES = new Set(['logo', 'photo_seed']);
const POST_MEDIA_ASSET_TYPES = new Set([
  'post_media_before',
  'post_media_after',
  'post_media_single',
  'post_media_video',
]);
const ALLOWED_ASSET_TYPES = new Set([
  ...PERSISTENT_ASSET_TYPES,
  ...POST_MEDIA_ASSET_TYPES,
]);

router.post('/upload-asset', uploadHandler.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }
    const assetType = String(req.body?.asset_type || '').toLowerCase();
    if (!ALLOWED_ASSET_TYPES.has(assetType)) {
      return res.status(400).json({
        success: false,
        error: `asset_type must be one of: ${[...ALLOWED_ASSET_TYPES].join(', ')}`,
      });
    }

    const db = getUserClient(req);
    const tenantSlug = req.tenant?.slug || req.tenantId;
    const ext = (req.file.originalname.match(/\.[a-z0-9]+$/i) || ['.png'])[0];
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
    const objectPath = `${tenantSlug}/${assetType}/${filename}`;

    const { error: uploadErr } = await db.storage
      .from('tenant-assets')
      .upload(objectPath, req.file.buffer, {
        contentType: req.file.mimetype || 'application/octet-stream',
        upsert: false,
      });
    if (uploadErr) throw uploadErr;

    const { data: publicData } = db.storage.from('tenant-assets').getPublicUrl(objectPath);
    const url = publicData?.publicUrl;

    if (assetType === 'logo') {
      await db.from('tenant_config').upsert(
        { tenant_id: req.tenantId, key: 'logo_url', value: url },
        { onConflict: 'tenant_id,key' }
      );
    } else if (assetType === 'photo_seed') {
      // Append to photo_seed_urls array
      const { data: existingRow } = await db
        .from('tenant_config')
        .select('value')
        .eq('tenant_id', req.tenantId)
        .eq('key', 'photo_seed_urls')
        .maybeSingle();
      const existing = Array.isArray(existingRow?.value) ? existingRow.value : [];
      await db.from('tenant_config').upsert(
        { tenant_id: req.tenantId, key: 'photo_seed_urls', value: [...existing, url] },
        { onConflict: 'tenant_id,key' }
      );
    }
    // post_media_* asset_types are intentionally NOT persisted to
    // tenant_config — they belong to a single draft. The caller is
    // expected to pass the returned URL into /api/content/generate.

    res.json({ success: true, url, asset_type: assetType });
  } catch (err) {
    log.error(`upload-asset failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/tenant/import-customers
 *
 * Bulk-import a customer list during onboarding. Accepts either:
 *   - multipart/form-data with a 'file' field (CSV); or
 *   - JSON { rows: [{name,email,phone,...}] } for clients that
 *     pre-parsed the CSV in the UI.
 *
 * CSV header is auto-detected (case-insensitive). Recognized columns:
 *   name (or first_name + last_name), email, phone, company, notes.
 * Unknown columns land in contact.metadata.
 *
 * Returns: { success, imported, skipped, errors }.
 */
router.post('/import-customers', uploadHandler.single('file'), async (req, res) => {
  try {
    const db = getUserClient(req);

    // Parse incoming CSV or JSON body into a row array
    let rows = [];
    if (req.file && req.file.buffer) {
      rows = parseCsvBuffer(req.file.buffer);
    } else if (Array.isArray(req.body?.rows)) {
      rows = req.body.rows;
    } else {
      return res.status(400).json({ success: false, error: 'Provide CSV file or rows[] in body' });
    }

    if (!rows.length) {
      return res.json({ success: true, imported: 0, skipped: 0, errors: [] });
    }

    const inserts = [];
    const errors = [];
    for (const row of rows) {
      const norm = normalizeCustomerRow(row);
      if (!norm.name && !norm.email && !norm.phone) {
        errors.push({ row, reason: 'no name/email/phone' });
        continue;
      }
      inserts.push({
        tenant_id: req.tenantId,
        name: norm.name || norm.email || norm.phone,
        email: norm.email || null,
        phone: norm.phone || null,
        company: norm.company || null,
        contact_type: 'customer',
        notes: norm.notes || null,
        metadata: norm.extra || {},
      });
    }

    let imported = 0;
    if (inserts.length) {
      // Use upsert-on-(tenant_id, email) where possible. Supabase
      // doesn't enforce that uniqueness here, so we just insert and
      // accept duplicates — onboarding-time imports are one-shot.
      const { data, error } = await db.from('contacts').insert(inserts).select('id');
      if (error) throw error;
      imported = (data || []).length;
    }

    res.json({
      success: true,
      imported,
      skipped: errors.length,
      errors: errors.slice(0, 20), // truncate verbose errors
    });
  } catch (err) {
    log.error(`import-customers failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Minimal CSV parser — handles header row, quoted fields, embedded
 * commas inside quotes. Not RFC 4180 perfect but covers the
 * Gmail / iCloud / spreadsheet exports our customers will hand us.
 */
function parseCsvBuffer(buf) {
  const text = buf.toString('utf-8').replace(/\r\n/g, '\n');
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  if (!lines.length) return [];
  const splitRow = (line) => {
    const out = [];
    let cur = '';
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQuote) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') inQuote = false;
        else cur += c;
      } else {
        if (c === ',') { out.push(cur); cur = ''; }
        else if (c === '"') inQuote = true;
        else cur += c;
      }
    }
    out.push(cur);
    return out;
  };
  const headers = splitRow(lines[0]).map((h) => h.trim().toLowerCase());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitRow(lines[i]);
    const obj = {};
    for (let j = 0; j < headers.length; j++) {
      obj[headers[j]] = (cells[j] || '').trim();
    }
    rows.push(obj);
  }
  return rows;
}

/**
 * Map heterogeneous CSV columns to our contact shape.
 */
function normalizeCustomerRow(raw) {
  // Pick well-known synonyms
  const pick = (...keys) => {
    for (const k of keys) {
      if (raw[k] !== undefined && raw[k] !== null && String(raw[k]).trim().length) {
        return String(raw[k]).trim();
      }
    }
    return '';
  };

  const first = pick('first_name', 'firstname', 'given_name', 'first');
  const last = pick('last_name', 'lastname', 'family_name', 'last');
  let name = pick('name', 'full_name', 'fullname');
  if (!name && (first || last)) name = `${first} ${last}`.trim();

  const email = pick('email', 'email_address');
  const phone = pick('phone', 'mobile', 'phone_number', 'cell', 'cellphone');
  const company = pick('company', 'organization', 'organisation', 'business');
  const notes = pick('notes', 'note', 'comment', 'comments');

  // Stash everything else in metadata so we don't lose info
  const wellKnown = new Set([
    'first_name','firstname','given_name','first',
    'last_name','lastname','family_name','last',
    'name','full_name','fullname',
    'email','email_address',
    'phone','mobile','phone_number','cell','cellphone',
    'company','organization','organisation','business',
    'notes','note','comment','comments',
  ]);
  const extra = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!wellKnown.has(k) && v) extra[k] = v;
  }

  return { name, email, phone, company, notes, extra: Object.keys(extra).length ? extra : null };
}

// ---------------------------------------------------------------------------
// GET /api/tenant/website — Get tenant's DFY website status and config
// ---------------------------------------------------------------------------
router.get('/website', async (req, res) => {
  try {
    const db = getUserClient(req);
    const tid = req.tenantId;

    const { data: website } = await db
      .from('tenant_websites')
      .select('*')
      .eq('tenant_id', tid)
      .maybeSingle();

    if (!website) {
      return res.json({ success: true, website: null });
    }

    res.json({
      success: true,
      website: {
        id: website.id,
        domain: website.domain,
        subdomain: website.subdomain,
        status: website.status,
        template: website.template,
        published_at: website.published_at,
        url: website.domain ? `https://${website.domain}` : `https://${website.subdomain}`,
      },
    });
  } catch (err) {
    log.error('GET /api/tenant/website failed', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/tenant/website — Update website content and trigger rebuild
// Accepts partial page_data updates. Queues a rebuild job.
// ---------------------------------------------------------------------------
router.patch('/website', async (req, res) => {
  try {
    const db = getUserClient(req);
    const tid = req.tenantId;

    const { data: website } = await db
      .from('tenant_websites')
      .select('id, page_data')
      .eq('tenant_id', tid)
      .maybeSingle();

    if (!website) {
      return res.status(404).json({ error: 'No website configured for this tenant' });
    }

    const updates = req.body || {};
    const allowedFields = [
      'tagline', 'about_blurb', 'testimonials', 'cta_preference',
      'services', 'hours', 'service_area', 'phone', 'email',
    ];
    const configUpdates = [];
    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        configUpdates.push({
          tenant_id: tid,
          key: `module_website_${field}`,
          value: updates[field],
        });
      }
    }

    if (configUpdates.length > 0) {
      await db.from('tenant_config').upsert(configUpdates, { onConflict: 'tenant_id,key' });
    }

    // Update status to 'building' and queue a rebuild job
    await db.from('tenant_websites')
      .update({ status: 'building', updated_at: new Date().toISOString() })
      .eq('tenant_id', tid);

    await db.from('agent_jobs').insert({
      tenant_id: tid,
      agent_name: 'dfy-website-build',
      status: 'pending',
      payload: { rebuild: true },
    });

    res.json({ success: true, message: 'Website rebuild queued' });
  } catch (err) {
    log.error('PATCH /api/tenant/website failed', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/tenant/support/threads — Support threads for THIS tenant
// Mirrors /api/admin/support/threads but scoped to req.tenantId.
// ---------------------------------------------------------------------------
router.get('/support/threads', async (req, res) => {
  try {
    const db = getUserClient(req);
    const status = (req.query.status || 'open').toString();
    let query = db
      .from('support_threads')
      .select('id, from_name, from_email, subject, status, last_message_at, tenant_id')
      .eq('tenant_id', req.tenantId)
      .order('last_message_at', { ascending: false })
      .limit(100);
    if (status !== 'all') query = query.eq('status', status);
    const { data, error } = await query;
    if (error) {
      if (/relation .* does not exist/i.test(error.message)) {
        return res.json({ success: true, threads: [] });
      }
      throw error;
    }

    // Attach message count + preview per thread.
    const threadIds = (data || []).map(t => t.id);
    const countsRes = threadIds.length
      ? await db.from('support_messages').select('thread_id, body').in('thread_id', threadIds).order('created_at', { ascending: false })
      : { data: [] };
    const previewByThread = {};
    const countByThread = {};
    for (const m of (countsRes.data || [])) {
      countByThread[m.thread_id] = (countByThread[m.thread_id] || 0) + 1;
      if (!previewByThread[m.thread_id]) previewByThread[m.thread_id] = (m.body || '').slice(0, 120);
    }

    const threads = (data || []).map(t => ({
      ...t,
      tenant_name: req.tenant?.name || null,
      message_count: countByThread[t.id] || 0,
      preview: previewByThread[t.id] || '',
    }));

    res.json({ success: true, threads });
  } catch (err) {
    log.error(`Tenant support threads failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/support/threads/:threadId/messages', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { threadId } = req.params;
    // Verify thread belongs to this tenant
    const { data: thread } = await db
      .from('support_threads')
      .select('id')
      .eq('id', threadId)
      .eq('tenant_id', req.tenantId)
      .maybeSingle();
    if (!thread) return res.status(404).json({ success: false, error: 'Thread not found' });

    const { data, error } = await db
      .from('support_messages')
      .select('id, direction, from_email, to_email, subject, body, created_at')
      .eq('thread_id', threadId)
      .order('created_at', { ascending: true });
    if (error) {
      if (/relation .* does not exist/i.test(error.message)) {
        return res.json({ success: true, messages: [] });
      }
      throw error;
    }
    res.json({ success: true, messages: data || [] });
  } catch (err) {
    log.error(`Tenant support messages failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.patch('/support/threads/:threadId', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { threadId } = req.params;
    const updates = {};
    if (req.body?.status && ['open', 'pending', 'resolved'].includes(req.body.status)) {
      updates.status = req.body.status;
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, error: 'No valid fields to update' });
    }
    const { error } = await db
      .from('support_threads')
      .update(updates)
      .eq('id', threadId)
      .eq('tenant_id', req.tenantId);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    log.error(`Tenant support thread update failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/support/threads/:threadId/reply', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { threadId } = req.params;
    const body = (req.body?.body || '').toString().trim();
    if (!body) return res.status(400).json({ success: false, error: 'body required' });

    const { data: thread, error: threadErr } = await db
      .from('support_threads')
      .select('id, from_email, subject, status')
      .eq('id', threadId)
      .eq('tenant_id', req.tenantId)
      .maybeSingle();
    if (threadErr) throw threadErr;
    if (!thread) return res.status(404).json({ success: false, error: 'Thread not found' });

    // For demo tenants the demoWriteGuard already intercepts POST,
    // but if it reaches here (non-demo tenant), send the real email.
    // This reply goes to the tenant's OWN customer — it MUST use the tenant's
    // email identity, never FGA. Route through the identity gate (P0 fix).
    const { sendEmail } = require('../../integrations/email');
    const { resolveIdentity } = require('../../core/tenant-email-identity');
    const identity = resolveIdentity(req.tenant || { id: req.tenantId });
    const replySubject = thread.subject && /^re:/i.test(thread.subject)
      ? thread.subject
      : `Re: ${thread.subject || 'your support request'}`;
    const html = body.replace(/\n/g, '<br>');
    const sendResult = await sendEmail(thread.from_email, replySubject, html, {
      tenant: req.tenant || { id: req.tenantId },
      audience: 'customer',
      ownership: { thread: { tenant_id: req.tenantId } },
    });

    await db.from('support_messages').insert({
      thread_id: threadId,
      direction: 'outbound',
      from_email: identity.from_email || null,
      to_email: thread.from_email,
      subject: replySubject,
      body,
    });
    await db.from('support_threads').update({
      last_message_at: new Date().toISOString(),
      status: thread.status === 'resolved' ? 'open' : 'pending',
    }).eq('id', threadId);

    res.json({ success: true, sent: !!sendResult });
  } catch (err) {
    log.error(`Tenant support reply failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
