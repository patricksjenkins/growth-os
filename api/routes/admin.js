/**
 * Growth OS — Admin / Founder Routes
 * Cross-tenant visibility for the FGA mobile app.
 * All queries use the service client (bypasses RLS).
 */

const express = require('express');
const router = express.Router();
const { getServiceClient } = require('../../db/client');
const { createLogger } = require('../../core/logger');
const log = createLogger('admin');

// V1 hardening (2026-05-24): use the centralized constant from core/config.js
// instead of re-declaring the UUID literal in every file.
const { FGA_TENANT_ID } = require('../../core/config');

// V1 hardening (2026-05-24): pure helpers extracted to ./admin/_helpers.js
// as precondition for per-domain file split (V1.1). Behavior identical.
const { TIER_PRICING, SETUP_FEE_DEFAULT, readNumericConfig } = require('./admin/_helpers');

// ---------------------------------------------------------------------------
// GET /api/admin/overview — Cross-tenant business overview
// Demo tenants (is_demo = true) are excluded from platform aggregates and
// MRR — they are sales sandboxes, not real revenue. They're still returned
// in `demo_tenants` so the admin UI can render them separately if desired.
// ---------------------------------------------------------------------------
router.get('/overview', async (req, res) => {
  try {
    const db = getServiceClient();

    // Fetch all active tenants (include is_demo so we can split below)
    const { data: allTenants, error: tenantErr } = await db
      .from('tenants')
      .select('id, name, slug, vertical, status, is_demo, created_at')
      .eq('status', 'active');

    if (tenantErr) throw tenantErr;

    // Exclude (a) demo tenants and (b) FGA itself from the client-aggregate
    // view. FGA is the PLATFORM, not a client — showing FGA in the Client
    // Accounts list + counting FGA's own prospecting leads in "Pipeline Leads"
    // creates a confusing "Saas-Company — At Risk" row that doesn't make
    // sense (we ARE the company). Patrick's own sales pipeline lives at
    // /admin/pipeline, which still queries leads scoped to FGA_TENANT_ID.
    const tenants = (allTenants || []).filter(t => !t.is_demo && t.id !== FGA_TENANT_ID);
    const demoTenants = (allTenants || []).filter(t => t.is_demo);
    const platformTenant = (allTenants || []).find(t => t.id === FGA_TENANT_ID) || null;
    const tenantIds = tenants.map(t => t.id);

    // Parallel counts across NON-DEMO tenants only
    const [leadsRes, contentRes, configRes] = await Promise.all([
      tenantIds.length ? db.from('leads').select('tenant_id').in('tenant_id', tenantIds) : Promise.resolve({ data: [] }),
      tenantIds.length ? db.from('content_drafts').select('tenant_id, status').in('tenant_id', tenantIds) : Promise.resolve({ data: [] }),
      tenantIds.length ? db.from('tenant_config').select('tenant_id, key, value').in('key', ['tier', 'monthly_rate']).in('tenant_id', tenantIds) : Promise.resolve({ data: [] }),
    ]);

    // Build per-tenant stats
    const tenantStats = tenants.map(tenant => {
      const leadCount = (leadsRes.data || []).filter(l => l.tenant_id === tenant.id).length;
      const tenantContent = (contentRes.data || []).filter(c => c.tenant_id === tenant.id);
      const tierConfig = (configRes.data || []).find(c => c.tenant_id === tenant.id && c.key === 'tier');
      const rateConfig = (configRes.data || []).find(c => c.tenant_id === tenant.id && c.key === 'monthly_rate');
      const tier = tierConfig?.value || 'growth';
      const monthlyRate = readNumericConfig(rateConfig?.value, TIER_PRICING[tier] !== undefined ? TIER_PRICING[tier] : TIER_PRICING.growth);

      return {
        ...tenant,
        tier,
        monthly_rate: monthlyRate,
        lead_count: leadCount,
        content_count: tenantContent.length,
        content_by_status: {
          draft: tenantContent.filter(c => c.status === 'draft').length,
          approved: tenantContent.filter(c => c.status === 'approved').length,
          posted: tenantContent.filter(c => c.status === 'posted').length
        }
      };
    });

    // Calculate MRR from actual per-tenant rates (excludes demos)
    let mrr = 0;
    for (const t of tenantStats) {
      mrr += t.monthly_rate;
    }

    // Founder pipeline summary — FGA's own sales prospecting (the leads
    // PATRICK is trying to convert into customers). Kept separate from
    // client aggregates above so the dashboard can render both views
    // distinctly: "what's my client business doing?" + "what's my own
    // sales work look like?"
    let founderPipeline = { total_leads: 0, by_status: {} };
    if (platformTenant) {
      const { data: founderLeads } = await db
        .from('leads')
        .select('status')
        .eq('tenant_id', FGA_TENANT_ID);
      const byStatus = {};
      for (const l of founderLeads || []) {
        const s = l.status || 'unknown';
        byStatus[s] = (byStatus[s] || 0) + 1;
      }
      founderPipeline = {
        total_leads: (founderLeads || []).length,
        by_status: byStatus,
      };
    }

    res.json({
      success: true,
      tenants: tenantStats,
      demo_tenants: demoTenants,
      platform_tenant: platformTenant,  // FGA itself — shown separately, not counted in client aggregates
      founder_pipeline: founderPipeline,  // Patrick's own sales prospecting summary
      totals: {
        total_tenants: tenants.length,
        total_leads: (leadsRes.data || []).length,
        total_content: (contentRes.data || []).length,
        mrr
      }
    });
  } catch (err) {
    log.error(`Admin overview failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/admin/pipeline — PAP's own sales pipeline (FGA tenant)
// ---------------------------------------------------------------------------
router.get('/pipeline', async (req, res) => {
  try {
    const db = getServiceClient();

    const { data: leads, error } = await db
      .from('leads')
      .select('*')
      .eq('tenant_id', FGA_TENANT_ID)
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Batch-fetch the latest outreach sequence for each lead so the
    // pipeline list can show a draft preview without N+1 API calls.
    const leadIds = (leads || []).map(l => l.id);
    let outreachMap = {};
    if (leadIds.length > 0) {
      const { data: sequences } = await db
        .from('outreach_sequences')
        .select('id, lead_id, sequence_status, sequence_type, message_subject, message_body, created_at')
        .eq('tenant_id', FGA_TENANT_ID)
        .in('lead_id', leadIds)
        .order('created_at', { ascending: false });

      // Keep only the most recent sequence per lead
      for (const seq of (sequences || [])) {
        if (!outreachMap[seq.lead_id]) {
          outreachMap[seq.lead_id] = seq;
        }
      }
    }

    // Attach outreach_draft to each lead
    const leadsWithOutreach = (leads || []).map(l => ({
      ...l,
      outreach_draft: outreachMap[l.id] || null,
    }));

    // Group by status
    const pipeline = {};
    for (const lead of leadsWithOutreach) {
      const status = lead.status || 'new_lead';
      pipeline[status] = (pipeline[status] || 0) + 1;
    }

    res.json({
      success: true,
      pipeline,
      leads: leadsWithOutreach
    });
  } catch (err) {
    log.error(`Admin pipeline failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/admin/pipeline — Add a prospect to PAP's pipeline
// ---------------------------------------------------------------------------
router.post('/pipeline', async (req, res) => {
  try {
    const db = getServiceClient();
    const { company_name, name, email, phone, service_type, city, lead_source, status, notes } = req.body;

    if (!company_name && !name) {
      return res.status(400).json({ success: false, error: 'Company name or contact name required' });
    }

    const resolvedName = name || company_name;
    const resolvedCompany = company_name || name;

    const { data: lead, error } = await db
      .from('leads')
      .insert({
        tenant_id: FGA_TENANT_ID,
        company_name: resolvedCompany,
        name: resolvedName,
        email: email || null,
        phone: phone || null,
        service_type: service_type || null,
        city: city || null,
        lead_source: lead_source || 'manual',
        status: status || 'new_lead',
        // Start as a prospect so the enrichment agent picks it up.
        lifecycle_stage: 'prospect',
        enrichment_status: 'pending',
        notes: notes || null,
      })
      .select()
      .single();

    if (error) throw error;

    // Auto-enrich the manual lead — same behavior as POST /api/leads.
    // Skips if it's being created already-enriched (bulk import path).
    try {
      await db.from('agent_jobs').insert({
        tenant_id: FGA_TENANT_ID,
        agent_name: 'enrichment',
        payload: { lead_id: lead.id },
        status: 'pending',
        priority: 7,
      });
    } catch (e) {
      log.warn(`Could not enqueue enrichment for manual pipeline lead: ${e.message}`);
    }

    res.json({ success: true, lead });
  } catch (err) {
    log.error(`Admin pipeline add failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/admin/pipeline/:leadId — Single lead detail
// ---------------------------------------------------------------------------
router.get('/pipeline/:leadId', async (req, res) => {
  try {
    const db = getServiceClient();
    const { leadId } = req.params;

    const { data: lead, error } = await db
      .from('leads')
      .select('*')
      .eq('id', leadId)
      .eq('tenant_id', FGA_TENANT_ID)
      .single();

    if (error) throw error;
    if (!lead) return res.status(404).json({ success: false, error: 'Lead not found' });

    res.json({ success: true, lead });
  } catch (err) {
    log.error(`Admin pipeline detail failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/admin/pipeline/:leadId — Update a pipeline lead's status/details
// ---------------------------------------------------------------------------
router.patch('/pipeline/:leadId', async (req, res) => {
  try {
    const db = getServiceClient();
    const { leadId } = req.params;
    const updates = {};

    const allowed = ['status', 'company_name', 'name', 'email', 'phone', 'service_type', 'city', 'lead_source', 'notes', 'priority_tier', 'lead_score'];
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, error: 'No fields to update' });
    }

    const { data: lead, error } = await db
      .from('leads')
      .update(updates)
      .eq('id', leadId)
      .eq('tenant_id', FGA_TENANT_ID)
      .select()
      .single();

    if (error) throw error;

    res.json({ success: true, lead });
  } catch (err) {
    log.error(`Admin pipeline update failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/admin/pipeline/:leadId/outreach — Pending outreach draft for a lead
//
// Returns the most recent draft outreach sequence (with the conversation
// metadata holding HTML body if present) so the mobile lead-detail screen
// can render the email/DM for Patrick's review.
// ---------------------------------------------------------------------------
router.get('/pipeline/:leadId/outreach', async (req, res) => {
  try {
    const db = getServiceClient();
    const { leadId } = req.params;

    // Latest sequence — covers both 'draft', 'approved' (sent), 'rejected'
    // states so the UI can show history and current status.
    const { data: sequences, error: seqErr } = await db
      .from('outreach_sequences')
      .select('id, sequence_status, sequence_type, message_subject, message_body, created_at, contact_id')
      .eq('lead_id', leadId)
      .eq('tenant_id', FGA_TENANT_ID)
      .order('created_at', { ascending: false })
      .limit(1);
    if (seqErr) throw seqErr;

    const sequence = sequences && sequences[0] ? sequences[0] : null;

    // Return ALL conversations for this lead (SMS, email, DM — any direction)
    // so the timeline shows the full history.
    const { data: conversations } = await db
      .from('conversations')
      .select('id, channel, direction, message_subject, message_body, metadata, created_at')
      .eq('tenant_id', FGA_TENANT_ID)
      .eq('lead_id', leadId)
      .order('created_at', { ascending: false });

    res.json({ success: true, sequence, conversations: conversations || [] });
  } catch (err) {
    log.error(`Admin outreach fetch failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/admin/pipeline/:leadId/outreach/approve — Approve & send the draft
//
// For email channel: marks sequence approved, sends via Resend, updates the
// conversation row to outbound/sent, advances the lead's lifecycle_stage.
// For facebook_dm channel: marks the sequence approved but does NOT
// auto-send (FB DMs require manual sending — Patrick clicks the FB link).
// ---------------------------------------------------------------------------
router.post('/pipeline/:leadId/outreach/approve', async (req, res) => {
  try {
    const db = getServiceClient();
    const { leadId } = req.params;
    const { sequence_id } = req.body || {};

    if (!sequence_id) {
      return res.status(400).json({ success: false, error: 'sequence_id is required' });
    }

    // Load sequence, conversation, lead, contact
    const { data: sequence, error: seqErr } = await db
      .from('outreach_sequences')
      .select('*')
      .eq('id', sequence_id)
      .eq('tenant_id', FGA_TENANT_ID)
      .single();
    if (seqErr || !sequence) {
      return res.status(404).json({ success: false, error: 'Sequence not found' });
    }
    if (sequence.sequence_status !== 'draft') {
      return res.status(400).json({ success: false, error: `Sequence is already ${sequence.sequence_status}` });
    }

    let toEmail = null;
    let htmlBody = null;
    if (sequence.sequence_type === 'email') {
      // Need recipient email and ideally the HTML body
      const { data: contact } = await db
        .from('contacts')
        .select('email, first_name, last_name')
        .eq('id', sequence.contact_id)
        .single();
      toEmail = contact?.email;
      if (!toEmail) {
        return res.status(400).json({ success: false, error: 'Contact has no email address' });
      }
      const { data: conv } = await db
        .from('conversations')
        .select('metadata, message_body')
        .eq('sequence_id', sequence.id)
        .order('created_at', { ascending: false })
        .limit(1);
      htmlBody = conv && conv[0]?.metadata?.body_html
        ? conv[0].metadata.body_html
        : `<p>${(sequence.message_body || '').replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>')}</p>`;
    }

    // Email send (only for email channel)
    let sendResult = null;
    if (sequence.sequence_type === 'email') {
      const { sendEmail } = require('../../integrations/email');
      try {
        sendResult = await sendEmail(toEmail, sequence.message_subject, htmlBody, {
          replyTo: 'patrick@firstgenautomate.com',
        });
      } catch (sendErr) {
        log.error(`Outreach approve failed to send: ${sendErr.message}`);
        return res.status(500).json({ success: false, error: `Send failed: ${sendErr.message}` });
      }
    }

    // Mark sequence approved (and sent for email)
    await db.from('outreach_sequences')
      .update({
        sequence_status: sequence.sequence_type === 'email' ? 'sent' : 'approved',
        sent_at: sequence.sequence_type === 'email' ? new Date().toISOString() : null,
      })
      .eq('id', sequence_id)
      .eq('tenant_id', FGA_TENANT_ID);

    // Update conversation metadata
    await db.from('conversations')
      .update({
        metadata: {
          draft_status: sequence.sequence_type === 'email' ? 'sent' : 'approved',
          sent_at: new Date().toISOString(),
          send_result: sendResult || null,
        },
      })
      .eq('tenant_id', FGA_TENANT_ID)
      .eq('sequence_id', sequence_id);

    // Advance lead lifecycle so it doesn't re-draft
    await db.from('leads')
      .update({ lifecycle_stage: 'sequenced', status: 'contacted' })
      .eq('id', leadId)
      .eq('tenant_id', FGA_TENANT_ID);

    res.json({ success: true, channel: sequence.sequence_type, send_result: sendResult });
  } catch (err) {
    log.error(`Admin outreach approve failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/admin/pipeline/:leadId/outreach/:sequenceId — Edit the draft
//
// Lets Patrick fix small things in a draft (a stale price, a typo, a tone
// tweak) without re-firing the outreach agent and burning Claude tokens.
// Accepts { message_subject?, message_body? }. Body update is also mirrored
// onto the conversation row so the mobile approval queue + approve handler
// stay in sync. Only allowed while the sequence is still in 'draft' status.
// ---------------------------------------------------------------------------
router.patch('/pipeline/:leadId/outreach/:sequenceId', async (req, res) => {
  try {
    const db = getServiceClient();
    const { leadId, sequenceId } = req.params;
    const { message_subject, message_body } = req.body || {};

    const subjProvided = typeof message_subject === 'string';
    const bodyProvided = typeof message_body === 'string';
    if (!subjProvided && !bodyProvided) {
      return res.status(400).json({ success: false, error: 'message_subject or message_body is required' });
    }

    // Verify the sequence belongs to FGA + the lead + is still editable.
    const { data: sequence, error: seqErr } = await db
      .from('outreach_sequences')
      .select('id, sequence_status, sequence_type, lead_id')
      .eq('id', sequenceId)
      .eq('tenant_id', FGA_TENANT_ID)
      .single();

    if (seqErr || !sequence) {
      return res.status(404).json({ success: false, error: 'Sequence not found' });
    }
    if (sequence.lead_id !== leadId) {
      return res.status(400).json({ success: false, error: 'Sequence does not belong to lead' });
    }
    if (sequence.sequence_status !== 'draft') {
      return res.status(400).json({ success: false, error: `Cannot edit — sequence is ${sequence.sequence_status}` });
    }

    const seqUpdates = { updated_at: new Date().toISOString() };
    if (subjProvided) seqUpdates.message_subject = message_subject.trim() || null;
    if (bodyProvided) seqUpdates.message_body = message_body.trim() || null;

    const { error: updErr } = await db
      .from('outreach_sequences')
      .update(seqUpdates)
      .eq('id', sequenceId)
      .eq('tenant_id', FGA_TENANT_ID);
    if (updErr) {
      log.error(`Outreach edit failed: ${updErr.message}`);
      return res.status(500).json({ success: false, error: updErr.message });
    }

    // Mirror the edit onto the conversation row (mobile approval queue
    // reads from this) AND regenerate the html body so the approve
    // handler doesn't blast out an outdated cached HTML version.
    if (bodyProvided || subjProvided) {
      const { data: convRows } = await db
        .from('conversations')
        .select('id, metadata')
        .eq('sequence_id', sequenceId)
        .order('created_at', { ascending: false })
        .limit(1);

      if (convRows && convRows[0]) {
        const convUpdates = { updated_at: new Date().toISOString() };
        if (subjProvided) convUpdates.message_subject = seqUpdates.message_subject;
        if (bodyProvided) {
          convUpdates.message_body = seqUpdates.message_body;
          // Rebuild body_html from the new plain text so the approve
          // handler's email send picks up the edit. Same simple conversion
          // the outreach agent uses for plain-text fallback.
          const md = {
            ...(convRows[0].metadata || {}),
            body_html: `<p>${(seqUpdates.message_body || '').replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>')}</p>`,
            edited_at: new Date().toISOString(),
          };
          convUpdates.metadata = md;
        }
        await db.from('conversations')
          .update(convUpdates)
          .eq('id', convRows[0].id);
      }
    }

    res.json({ success: true });
  } catch (err) {
    log.error(`Admin outreach edit failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/admin/pipeline/:leadId/outreach/reject — Reject the draft
//
// Marks the draft rejected so it won't auto-send. Lead stays at 'enriched'
// stage so the next outreach run can re-draft a fresh version.
// ---------------------------------------------------------------------------
router.post('/pipeline/:leadId/outreach/reject', async (req, res) => {
  try {
    const db = getServiceClient();
    const { leadId } = req.params;
    const { sequence_id, reason } = req.body || {};

    if (!sequence_id) {
      return res.status(400).json({ success: false, error: 'sequence_id is required' });
    }

    const trimmedReason = (reason || '').trim();

    await db.from('outreach_sequences')
      .update({ sequence_status: 'rejected' })
      .eq('id', sequence_id)
      .eq('tenant_id', FGA_TENANT_ID);

    await db.from('conversations')
      .update({
        metadata: {
          draft_status: 'rejected',
          rejected_at: new Date().toISOString(),
          reject_reason: trimmedReason || null,
        },
      })
      .eq('tenant_id', FGA_TENANT_ID)
      .eq('sequence_id', sequence_id);

    // Reset lead to 'enriched' so it gets re-drafted on next outreach run.
    await db.from('leads')
      .update({ lifecycle_stage: 'enriched' })
      .eq('id', leadId)
      .eq('tenant_id', FGA_TENANT_ID);

    // Immediately enqueue a single-lead outreach run with the feedback so
    // Patrick doesn't have to wait for the next cron. The outreach agent
    // already supports payload.lead_id for single-lead mode; we add
    // regenerate_feedback which it injects into the prompt.
    let regeneratedJobId = null;
    const { data: job, error: jobErr } = await db.from('agent_jobs').insert({
      tenant_id: FGA_TENANT_ID,
      agent_name: 'outreach',
      payload: {
        lead_id: leadId,
        regenerate_feedback: trimmedReason || null,
        rejected_sequence_id: sequence_id,
      },
      status: 'pending',
    }).select('id').single();
    if (jobErr) {
      log.warn(`Outreach regen queue failed: ${jobErr.message}`);
    } else {
      regeneratedJobId = job.id;
    }

    res.json({ success: true, regenerate_job_id: regeneratedJobId });
  } catch (err) {
    log.error(`Admin outreach reject failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/admin/clients — All tenants as "clients" with health metrics
// ---------------------------------------------------------------------------
router.get('/clients', async (req, res) => {
  try {
    const db = getServiceClient();

    const { data: tenants, error: tenantErr } = await db
      .from('tenants')
      .select('id, name, slug, vertical, status, created_at');

    if (tenantErr) throw tenantErr;

    const tenantIds = (tenants || []).map(t => t.id);

    const [tierRes, nameRes, leadsRes, contentRes] = await Promise.all([
      db.from('tenant_config').select('tenant_id, value').eq('key', 'tier').in('tenant_id', tenantIds),
      db.from('tenant_config').select('tenant_id, value').eq('key', 'business_name').in('tenant_id', tenantIds),
      db.from('leads').select('tenant_id, created_at').in('tenant_id', tenantIds),
      db.from('content_drafts').select('tenant_id, created_at').in('tenant_id', tenantIds)
    ]);

    const clients = (tenants || []).map(tenant => {
      const tierCfg = (tierRes.data || []).find(c => c.tenant_id === tenant.id);
      const nameCfg = (nameRes.data || []).find(c => c.tenant_id === tenant.id);
      const tenantLeads = (leadsRes.data || []).filter(l => l.tenant_id === tenant.id);
      const tenantContent = (contentRes.data || []).filter(c => c.tenant_id === tenant.id);

      const allDates = [
        ...tenantLeads.map(l => l.created_at),
        ...tenantContent.map(c => c.created_at)
      ].filter(Boolean).sort().reverse();
      const lastActivity = allDates[0] || null;

      let health = 'red';
      if (lastActivity) {
        const daysSince = (Date.now() - new Date(lastActivity).getTime()) / (1000 * 60 * 60 * 24);
        if (daysSince <= 7) health = 'green';
        else if (daysSince <= 30) health = 'yellow';
      }

      return {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        vertical: tenant.vertical,
        status: tenant.status,
        tier: tierCfg?.value || 'growth',
        business_name: nameCfg?.value || tenant.name,
        lead_count: tenantLeads.length,
        content_count: tenantContent.length,
        last_activity: lastActivity,
        health
      };
    });

    res.json({ success: true, clients });
  } catch (err) {
    log.error(`Admin clients failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/admin/clients/:tenantId — Single tenant detail
// ---------------------------------------------------------------------------
router.get('/clients/:tenantId', async (req, res) => {
  try {
    const db = getServiceClient();
    const { tenantId } = req.params;

    const [tenantRes, configRes, leadsRes, contentRes, modulesRes] = await Promise.all([
      db.from('tenants').select('*').eq('id', tenantId).single(),
      db.from('tenant_config').select('key, value').eq('tenant_id', tenantId),
      db.from('leads').select('status').eq('tenant_id', tenantId),
      db.from('content_drafts').select('status').eq('tenant_id', tenantId),
      db.from('tenant_modules').select('module, enabled').eq('tenant_id', tenantId)
    ]);

    if (tenantRes.error) throw tenantRes.error;
    if (!tenantRes.data) {
      return res.status(404).json({ success: false, error: 'Tenant not found' });
    }

    // Lead stats by status
    const leadStats = {};
    for (const lead of (leadsRes.data || [])) {
      const s = lead.status || 'unknown';
      leadStats[s] = (leadStats[s] || 0) + 1;
    }

    // Content stats by status
    const contentStats = {};
    for (const c of (contentRes.data || [])) {
      const s = c.status || 'unknown';
      contentStats[s] = (contentStats[s] || 0) + 1;
    }

    // Build config object from key/value pairs
    const config = {};
    for (const row of (configRes.data || [])) {
      config[row.key] = row.value;
    }

    res.json({
      success: true,
      tenant: {
        ...tenantRes.data,
        config
      },
      stats: {
        leads: { total: (leadsRes.data || []).length, by_status: leadStats },
        content: { total: (contentRes.data || []).length, by_status: contentStats }
      },
      modules: (modulesRes.data || []).map(m => ({
        name: m.module,
        enabled: m.enabled
      }))
    });
  } catch (err) {
    log.error(`Admin client detail failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/admin/clients/:tenantId — Update tenant settings
// ---------------------------------------------------------------------------
router.patch('/clients/:tenantId', async (req, res) => {
  try {
    const db = getServiceClient();
    const { tenantId } = req.params;
    const { tier, status, business_name, vertical, monthly_rate, setup_fee, setup_fee_paid, modules, is_complimentary } = req.body;

    // Update tenant-level fields (status, vertical) if provided
    const tenantUpdates = {};
    if (status) tenantUpdates.status = status;
    if (vertical) tenantUpdates.vertical = vertical;

    if (Object.keys(tenantUpdates).length > 0) {
      const { error } = await db
        .from('tenants')
        .update(tenantUpdates)
        .eq('id', tenantId);
      if (error) throw error;
    }

    // Update config values (tier, business_name, pricing, etc.)
    const configUpdates = [];
    if (tier) configUpdates.push({ tenant_id: tenantId, key: 'tier', value: tier });
    if (business_name) configUpdates.push({ tenant_id: tenantId, key: 'business_name', value: business_name });
    if (monthly_rate !== undefined) configUpdates.push({ tenant_id: tenantId, key: 'monthly_rate', value: monthly_rate });
    if (setup_fee !== undefined) configUpdates.push({ tenant_id: tenantId, key: 'setup_fee', value: setup_fee });
    if (setup_fee_paid !== undefined) configUpdates.push({ tenant_id: tenantId, key: 'setup_fee_paid', value: setup_fee_paid });
    // Complimentary flag — kept in tenant_config.is_complimentary so the
    // /api/admin/clients listing + finance MRR roll-up can exclude these
    // (already implemented at line ~868). Stored as the string 'true'/'false'
    // to match the rest of tenant_config's text-typed values.
    if (is_complimentary !== undefined) {
      configUpdates.push({
        tenant_id: tenantId,
        key: 'is_complimentary',
        value: is_complimentary === true || is_complimentary === 'true' ? 'true' : 'false',
      });
    }

    if (configUpdates.length > 0) {
      const { error } = await db
        .from('tenant_config')
        .upsert(configUpdates, { onConflict: 'tenant_id,key' });
      if (error) throw error;
    }

    // Update module toggles if provided
    if (modules && Array.isArray(modules)) {
      for (const mod of modules) {
        const { error } = await db
          .from('tenant_modules')
          .update({ enabled: mod.enabled })
          .eq('tenant_id', tenantId)
          .eq('module', mod.name);
        if (error) log.error(`Module update failed for ${mod.name}: ${error.message}`);
      }
    }

    res.json({ success: true, message: 'Tenant updated' });
  } catch (err) {
    log.error(`Admin client update failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/admin/clients/:tenantId — Delete a tenant and all associated data
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// GET /api/admin/me/config — FGA's own tenant_config (read)
// PATCH /api/admin/me/config — FGA's own tenant_config (write)
// ---------------------------------------------------------------------------
// Used by /admin/settings to edit the FGA tenant's brand voice, sender
// identity, outreach limits, etc. without going through the per-client
// editor.
router.get('/me/config', async (req, res) => {
  try {
    const db = getServiceClient();
    const { data, error } = await db
      .from('tenant_config')
      .select('key, value')
      .eq('tenant_id', FGA_TENANT_ID);
    if (error) throw error;
    const config = {};
    for (const row of (data || [])) config[row.key] = row.value;
    res.json({ success: true, config });
  } catch (err) {
    log.error(`Admin me/config GET failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.patch('/me/config', async (req, res) => {
  try {
    const db = getServiceClient();
    const updates = req.body || {};
    const rows = Object.entries(updates)
      .filter(([k]) => typeof k === 'string' && k.length > 0)
      .map(([key, value]) => ({ tenant_id: FGA_TENANT_ID, key, value: value == null ? '' : String(value) }));
    if (rows.length === 0) {
      return res.json({ success: true, updated: 0 });
    }
    const { error } = await db
      .from('tenant_config')
      .upsert(rows, { onConflict: 'tenant_id,key' });
    if (error) throw error;
    res.json({ success: true, updated: rows.length });
  } catch (err) {
    log.error(`Admin me/config PATCH failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/admin/attention — counts that feed the Dashboard "Needs Your
// Attention" card. Each count is a real query, not a guess.
// ---------------------------------------------------------------------------
router.get('/attention', async (req, res) => {
  try {
    const db = getServiceClient();
    const now = Date.now();
    const in48h = new Date(now + 48 * 60 * 60 * 1000).toISOString();
    const monthAgo = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();

    // Run all queries in parallel.
    const [
      pendingOutreachRes,
      pendingContentRes,
      unansweredRepliesRes,
      paymentFailuresRes,
      expiringTrialsRes,
      onboardingRes,
    ] = await Promise.all([
      // Outreach drafts pending approval — FGA tenant only.
      db.from('outreach_sequences')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', FGA_TENANT_ID)
        .eq('status', 'pending_approval'),

      // Content drafts pending approval (any tenant — FGA approves its own).
      db.from('content_drafts')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', FGA_TENANT_ID)
        .eq('status', 'pending'),

      // Inbound conversation replies in the last 7 days that have no outbound
      // response after them. Approximation: count inbound rows from last week
      // and let the UI link to the pipeline for triage.
      db.from('conversations')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', FGA_TENANT_ID)
        .eq('direction', 'inbound')
        .gte('created_at', new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString()),

      // Payment failures from Stripe — stored in tenant_config under the
      // payment_failed_at key. Each row is one failing tenant.
      db.from('tenant_config')
        .select('tenant_id', { count: 'exact', head: true })
        .eq('key', 'payment_failed_at'),

      // Trials ending in next 48h.
      db.from('tenant_config')
        .select('tenant_id', { count: 'exact', head: true })
        .eq('key', 'trial_ends_at')
        .lte('value', in48h)
        .gte('value', new Date(now).toISOString()),

      // Stalled onboardings: tenants created in last 30 days, status != active,
      // last agent activity > 2 days ago (or never).
      db.from('tenants')
        .select('id, status, created_at')
        .neq('status', 'active')
        .gte('created_at', monthAgo),
    ]);

    // Compute stalled count manually using the tenants list + agent_jobs.
    let stalledCount = 0;
    const tenantList = onboardingRes.data || [];
    if (tenantList.length > 0) {
      const ids = tenantList.map(t => t.id);
      const { data: jobs } = await db
        .from('agent_jobs')
        .select('tenant_id, created_at')
        .in('tenant_id', ids)
        .order('created_at', { ascending: false });
      const lastByTenant = {};
      for (const j of (jobs || [])) {
        if (!lastByTenant[j.tenant_id]) lastByTenant[j.tenant_id] = j.created_at;
      }
      const stalledMs = now - 2 * 24 * 60 * 60 * 1000;
      for (const t of tenantList) {
        const last = lastByTenant[t.id];
        const lastMs = last ? new Date(last).getTime() : new Date(t.created_at).getTime();
        if (lastMs < stalledMs) stalledCount += 1;
      }
    }

    res.json({
      success: true,
      pending_outreach: pendingOutreachRes.count || 0,
      pending_content: pendingContentRes.count || 0,
      unanswered_replies: unansweredRepliesRes.count || 0,
      payment_failures: paymentFailuresRes.count || 0,
      expiring_trials: expiringTrialsRes.count || 0,
      stalled_onboardings: stalledCount,
    });
  } catch (err) {
    log.error(`Admin attention failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/admin/clients/:tenantId/mark-founder-call — mark Day-5 call done
// ---------------------------------------------------------------------------
// Used by the Onboarding tracker so Patrick can mark the founder call
// complete from the admin UI after the call wraps. Writes
// tenant_config.founder_call_completed_at.
router.post('/clients/:tenantId/mark-founder-call', async (req, res) => {
  try {
    const db = getServiceClient();
    const { tenantId } = req.params;
    const { error } = await db
      .from('tenant_config')
      .upsert(
        { tenant_id: tenantId, key: 'founder_call_completed_at', value: new Date().toISOString() },
        { onConflict: 'tenant_id,key' }
      );
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    log.error(`mark-founder-call failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/admin/onboarding/status — REAL per-tenant onboarding state
// ---------------------------------------------------------------------------
// Returns each tenant currently in the 7-day onboarding window with
// step-by-step actual completion (derived from tenant_config, modules,
// agent_jobs, content_drafts, etc.) — NOT date-derived. Identifies
// stalled tenants (day > step.day + 2 and step incomplete) so Patrick
// can intervene from the admin portal.
router.get('/onboarding/status', async (req, res) => {
  try {
    const db = getServiceClient();

    // Pull every tenant + their config + module status + activity signal.
    const { data: tenants } = await db
      .from('tenants')
      .select('id, name, slug, status, vertical, created_at')
      .order('created_at', { ascending: false });

    if (!tenants || tenants.length === 0) {
      return res.json({ success: true, tenants: [] });
    }

    const tenantIds = tenants.map(t => t.id);
    const [configRes, modulesRes, jobsRes, draftsRes] = await Promise.all([
      db.from('tenant_config').select('tenant_id, key, value').in('tenant_id', tenantIds),
      db.from('tenant_modules').select('tenant_id, module, enabled').in('tenant_id', tenantIds),
      db.from('agent_jobs').select('tenant_id, agent_name, status, created_at').in('tenant_id', tenantIds).gte('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()),
      db.from('content_drafts').select('tenant_id, created_at').in('tenant_id', tenantIds),
    ]);

    const configByTenant = {};
    for (const row of (configRes.data || [])) {
      configByTenant[row.tenant_id] = configByTenant[row.tenant_id] || {};
      configByTenant[row.tenant_id][row.key] = row.value;
    }
    const modulesByTenant = {};
    for (const row of (modulesRes.data || [])) {
      modulesByTenant[row.tenant_id] = modulesByTenant[row.tenant_id] || {};
      modulesByTenant[row.tenant_id][row.module] = row.enabled;
    }
    const jobsByTenant = {};
    for (const row of (jobsRes.data || [])) {
      jobsByTenant[row.tenant_id] = jobsByTenant[row.tenant_id] || [];
      jobsByTenant[row.tenant_id].push(row);
    }
    const draftCountByTenant = {};
    for (const row of (draftsRes.data || [])) {
      draftCountByTenant[row.tenant_id] = (draftCountByTenant[row.tenant_id] || 0) + 1;
    }

    const result = tenants.map(t => {
      const config = configByTenant[t.id] || {};
      const modules = modulesByTenant[t.id] || {};
      const jobs = jobsByTenant[t.id] || [];
      const draftCount = draftCountByTenant[t.id] || 0;

      const createdMs = new Date(t.created_at).getTime();
      const daysSince = Math.floor((Date.now() - createdMs) / 86400000);
      const lastJob = jobs.reduce((latest, j) => {
        const d = new Date(j.created_at).getTime();
        return d > latest ? d : latest;
      }, 0);
      const lastActionAt = lastJob ? new Date(lastJob).toISOString() : null;

      // Derive real step completion from actual data.
      const steps = [
        { day: 0, key: 'tenant_created', label: 'Tenant created', done: true },
        { day: 0, key: 'welcome_sent', label: 'Welcome email + magic link sent', done: !!config.welcome_email_sent_at },
        { day: 1, key: 'wizard_complete', label: 'Customer completed intake wizard', done: !!config.onboarding_state_complete || config.wizard_status === 'complete' },
        { day: 1, key: 'branding', label: 'Branding configured (logo, colors)', done: !!config.logo_url || !!config.brand_primary_color },
        { day: 2, key: 'twilio', label: 'Branded phone number provisioned', done: !!config.twilio_phone_number },
        { day: 2, key: 'app_icon', label: 'Branded app icon generated', done: !!config.app_icon_url },
        { day: 3, key: 'content_batch', label: 'Initial content batch generated', done: draftCount > 0 },
        { day: 4, key: 'modules_enabled', label: 'Modules enabled per plan', done: Object.values(modules).some(v => v) },
        { day: 5, key: 'founder_call', label: 'Day-5 founder onboarding call', done: !!config.founder_call_completed_at },
        { day: 6, key: 'apple_review', label: 'Apple App Store review', done: t.status === 'active' || !!config.app_store_live_at },
        { day: 7, key: 'go_live', label: 'GO LIVE — tenant status active', done: t.status === 'active' },
      ];

      // Stalled detection: a step that should have been done by today is still incomplete.
      const blockers = steps.filter(s => !s.done && daysSince > s.day + 1);
      const completedCount = steps.filter(s => s.done).length;
      const active = t.status !== 'active' && daysSince <= 30;
      const stalled = active && blockers.length > 0;

      return {
        id: t.id,
        name: t.name,
        slug: t.slug,
        status: t.status,
        vertical: t.vertical,
        created_at: t.created_at,
        days_since_signup: daysSince,
        last_action_at: lastActionAt,
        active,
        stalled,
        completed_count: completedCount,
        total_steps: steps.length,
        blockers: blockers.map(b => b.key),
        steps,
      };
    });

    res.json({ success: true, tenants: result });
  } catch (err) {
    log.error(`Admin onboarding status failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/admin/clients/:tenantId/usage — current-month usage vs tier caps
// ---------------------------------------------------------------------------
// Returns a per-column breakdown: { used, cap, remaining, pct } for SMS,
// email, voice, chat, image, claude spend, outreach. Used by the web admin
// to render a usage panel on each tenant's edit screen.
router.get('/clients/:tenantId/usage', async (req, res) => {
  try {
    const db = getServiceClient();
    const { tenantId } = req.params;
    const { resolveTenant } = require('../../core/tenant');
    const tenant = await resolveTenant(db, tenantId);
    if (!tenant) return res.status(404).json({ success: false, error: 'Tenant not found' });

    const { TIER_CAPS, getCap } = require('../../core/usage-caps');
    const { data: usage } = await db.from('tenant_usage').select('*').eq('tenant_id', tenantId).maybeSingle();
    const tier = (tenant.tier || tenant.subscription_tier || 'growth').toLowerCase();
    const columns = Object.keys(TIER_CAPS.scale || {});
    const breakdown = {};
    for (const col of columns) {
      const used = Number(usage?.[col] || 0);
      const cap = getCap(tenant, col);
      const pct = cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0;
      breakdown[col] = { used, cap, remaining: Math.max(0, cap - used), pct };
    }
    res.json({ success: true, tier, period: 'current_month', breakdown });
  } catch (err) {
    log.error(`Admin tenant usage failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/clients/:tenantId', async (req, res) => {
  try {
    const db = getServiceClient();
    const { tenantId } = req.params;

    // Verify tenant exists
    const { data: tenant, error: findErr } = await db
      .from('tenants')
      .select('id, name, slug')
      .eq('id', tenantId)
      .single();

    if (findErr || !tenant) {
      return res.status(404).json({ success: false, error: 'Tenant not found' });
    }

    log.info(`Deleting tenant: ${tenant.name} (${tenant.slug})`);

    // Delete all tenant data in order (child tables first)
    const tables = [
      'agent_jobs',
      'content_drafts',
      'leads',
      'outreach_campaigns',
      'outreach_messages',
      'finance_entries',
      'debt_tracker',
      'crew_daily_log',
      'crew_members',
      'tenant_config',
      'tenant_modules',
    ];

    for (const table of tables) {
      try {
        await db.from(table).delete().eq('tenant_id', tenantId);
      } catch (e) {
        // Table may not exist or have no rows — continue
        log.warn(`Delete from ${table} skipped: ${e.message}`);
      }
    }

    // Delete the tenant itself
    const { error: deleteErr } = await db
      .from('tenants')
      .delete()
      .eq('id', tenantId);

    if (deleteErr) throw deleteErr;

    log.success(`Tenant deleted: ${tenant.name} (${tenant.slug})`);
    res.json({ success: true, message: `Tenant "${tenant.name}" deleted` });
  } catch (err) {
    log.error(`Admin client delete failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/admin/finance — Financial overview (MRR, ARR, per-client breakdown)
// Uses per-tenant monthly_rate from tenant_config, falls back to tier defaults.
// ---------------------------------------------------------------------------
router.get('/finance', async (req, res) => {
  try {
    const db = getServiceClient();

    // Get all tenants (not just active, so we can show paused/churned too)
    const { data: allTenants, error: tenantErr } = await db
      .from('tenants')
      .select('id, name, status');

    if (tenantErr) throw tenantErr;

    const tenantIds = (allTenants || []).map(t => t.id);

    // Fetch all relevant config keys in one query
    const { data: configs, error: configErr } = await db
      .from('tenant_config')
      .select('tenant_id, key, value')
      .in('key', ['tier', 'monthly_rate', 'setup_fee', 'setup_fee_paid', 'business_name', 'is_complimentary', 'monthly_cost'])
      .in('tenant_id', tenantIds);

    if (configErr) throw configErr;

    // Build per-tenant config map
    const configMap = {};
    for (const c of (configs || [])) {
      if (!configMap[c.tenant_id]) configMap[c.tenant_id] = {};
      configMap[c.tenant_id][c.key] = c.value;
    }

    // Fetch per-tenant expense totals from finance_entries (if table exists)
    let expenseByTenant = {};
    try {
      const { data: expData } = await db
        .from('finance_entries')
        .select('tenant_id, amount')
        .eq('entry_type', 'expense')
        .not('tenant_id', 'is', null);
      for (const e of (expData || [])) {
        expenseByTenant[e.tenant_id] = (expenseByTenant[e.tenant_id] || 0) + parseFloat(e.amount || 0);
      }
    } catch (_) { /* finance_entries may not exist yet */ }

    // Build per-client breakdown
    const clients = [];
    let mrr = 0;
    let mrrComplimentary = 0;
    let totalSetupFees = 0;
    let setupFeesPaid = 0;
    let totalMonthlyCost = 0;
    const byTier = { growth: 0, scale: 0 };

    for (const tenant of (allTenants || [])) {
      const cfg = configMap[tenant.id] || {};
      const tier = cfg.tier || 'growth';
      const isComplimentary = cfg.is_complimentary === 'true' || cfg.is_complimentary === true;
      // readNumericConfig respects an explicit 0 — without it, a tenant
      // whose rate is genuinely $0 (e.g. the Apex Plumbing demo) gets
      // silently bumped up to the tier default. See helper above.
      const tierDefault = TIER_PRICING[tier] !== undefined ? TIER_PRICING[tier] : TIER_PRICING.growth;
      const customRate = readNumericConfig(cfg.monthly_rate, null);
      const monthlyRate = customRate !== null ? customRate : tierDefault;
      const setupFee = readNumericConfig(cfg.setup_fee, SETUP_FEE_DEFAULT);
      const setupFeePaid = cfg.setup_fee_paid === 'true' || cfg.setup_fee_paid === true;
      // Per-tenant monthly cost: use explicit config if set, otherwise
      // estimate from recorded expenses or fall back to $0 (no guessing)
      const monthlyCost = readNumericConfig(cfg.monthly_cost, null);
      const recordedExpenses = expenseByTenant[tenant.id] || 0;
      const estimatedMonthlyCost = monthlyCost !== null ? monthlyCost : recordedExpenses;

      const clientEntry = {
        id: tenant.id,
        name: cfg.business_name || tenant.name,
        status: tenant.status,
        tier,
        monthly_rate: monthlyRate,
        custom_rate: customRate !== null,
        setup_fee: setupFee,
        setup_fee_paid: setupFeePaid,
        is_complimentary: isComplimentary,
        monthly_cost: estimatedMonthlyCost,
        margin: monthlyRate - estimatedMonthlyCost,
      };

      clients.push(clientEntry);

      // Only count active, non-complimentary tenants toward MRR
      if (tenant.status === 'active') {
        if (isComplimentary) {
          mrrComplimentary += monthlyRate;
        } else {
          mrr += monthlyRate;
          byTier[tier] = (byTier[tier] || 0) + 1;
        }
        totalMonthlyCost += estimatedMonthlyCost;
      }

      totalSetupFees += setupFee;
      if (setupFeePaid) setupFeesPaid += setupFee;
    }

    const arr = mrr * 12;
    const platformMargin = mrr - totalMonthlyCost;
    const platformMarginPercent = mrr > 0 ? ((platformMargin / mrr) * 100).toFixed(1) : '0.0';

    // Revenue history from finance_entries (if available)
    let revenueHistory = [];
    try {
      const { data: historyData, error: histErr } = await db
        .from('finance_entries')
        .select('date, amount')
        .eq('entry_type', 'income')
        .eq('category', 'subscription')
        .order('date', { ascending: true });

      if (!histErr && historyData) {
        const monthlyMap = {};
        for (const entry of historyData) {
          const month = entry.date.substring(0, 7);
          monthlyMap[month] = (monthlyMap[month] || 0) + parseFloat(entry.amount || 0);
        }
        revenueHistory = Object.keys(monthlyMap).sort().map(month => ({
          month,
          revenue: monthlyMap[month]
        }));
      }
    } catch (_) {
      // finance_entries may not exist yet — that's ok
    }

    res.json({
      success: true,
      mrr,
      arr,
      mrr_complimentary: mrrComplimentary,
      tenant_count: byTier.growth + byTier.scale,
      by_tier: byTier,
      clients,
      setup_fees: { total: totalSetupFees, paid: setupFeesPaid, outstanding: totalSetupFees - setupFeesPaid },
      revenue_history: revenueHistory,
      total_monthly_cost: totalMonthlyCost,
      platform_margin: platformMargin,
      platform_margin_percent: `${platformMarginPercent}%`,
    });
  } catch (err) {
    log.error(`Admin finance failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/admin/referrals — Module 10.6: Referral leaderboard
//
// Returns per-tenant referral activity grouped by referrer. Powers the
// "who's sending you the most business" view in the admin app.
// Optional query params:
//   ?tenant_id=<uuid>   — scope to a single tenant (default = FGA)
//   ?status=owed|paid   — filter to a specific credit lifecycle stage
// ---------------------------------------------------------------------------
router.get('/referrals', async (req, res) => {
  try {
    const db = getServiceClient();
    const tenantId = req.query.tenant_id || FGA_TENANT_ID;

    // Pull all credits for the tenant (or filter by status). Join referrer
    // and referee for human-readable names.
    let q = db
      .from('referral_credits')
      .select('id, amount, status, source, created_at, owed_at, paid_at, referrer_lead_id, referee_lead_id, referrer:leads!referral_credits_referrer_lead_id_fkey(id, name, company_name), referee:leads!referral_credits_referee_lead_id_fkey(id, name, company_name, status)')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false });
    if (req.query.status) q = q.eq('status', req.query.status);
    const { data: credits, error } = await q;
    if (error) throw error;

    // Aggregate per referrer for the leaderboard
    const byReferrer = new Map();
    for (const c of (credits || [])) {
      const rid = c.referrer_lead_id || 'unknown';
      if (!byReferrer.has(rid)) {
        byReferrer.set(rid, {
          referrer_lead_id: rid,
          referrer_name: c.referrer?.name || c.referrer?.company_name || 'Unknown',
          total_referrals: 0,
          won_referrals: 0,
          lost_referrals: 0,
          pending_referrals: 0,
          total_amount_owed: 0,
          total_amount_paid: 0,
        });
      }
      const row = byReferrer.get(rid);
      row.total_referrals++;
      const refereeStatus = c.referee?.status;
      if (refereeStatus === 'won') row.won_referrals++;
      else if (refereeStatus === 'lost') row.lost_referrals++;
      else row.pending_referrals++;
      const amount = Number(c.amount || 0);
      if (c.status === 'owed') row.total_amount_owed += amount;
      else if (c.status === 'paid') row.total_amount_paid += amount;
    }

    // Sort leaderboard by won_referrals DESC, then total_referrals DESC
    const leaderboard = [...byReferrer.values()].sort((a, b) =>
      b.won_referrals - a.won_referrals || b.total_referrals - a.total_referrals,
    );

    // Summary totals for the dashboard header
    const summary = {
      total_credits: (credits || []).length,
      pending: (credits || []).filter(c => c.status === 'pending').length,
      owed: (credits || []).filter(c => c.status === 'owed').length,
      paid: (credits || []).filter(c => c.status === 'paid').length,
      voided: (credits || []).filter(c => c.status === 'void').length,
      total_owed: (credits || []).filter(c => c.status === 'owed').reduce((s, c) => s + Number(c.amount || 0), 0),
      total_paid: (credits || []).filter(c => c.status === 'paid').reduce((s, c) => s + Number(c.amount || 0), 0),
    };

    res.json({ success: true, summary, leaderboard, credits });
  } catch (err) {
    log.error(`Referrals leaderboard failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/admin/referrals/:id/mark-paid — flip an owed credit to paid
router.post('/referrals/:id/mark-paid', async (req, res) => {
  try {
    const db = getServiceClient();
    const { data, error } = await db
      .from('referral_credits')
      .update({ status: 'paid', paid_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('status', 'owed')
      .select('id')
      .single();
    if (error) throw error;
    res.json({ success: true, credit_id: data?.id || null });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/admin/wizard-analytics — Onboarding wizard drop-off funnel
// Returns per-step completion counts across all tenants so the admin can
// see where customers abandon the wizard.
// ---------------------------------------------------------------------------
router.get('/wizard-analytics', async (req, res) => {
  try {
    const db = getServiceClient();
    const { STEP_DEFINITIONS } = require('../../core/onboarding-step-resolver');
    const allStepKeys = STEP_DEFINITIONS.map(s => s.key);

    // Pull all wizard step_completed events
    const { data: events, error: evErr } = await db
      .from('activity_log')
      .select('tenant_id, details, created_at')
      .eq('agent', 'onboarding_wizard')
      .eq('action', 'step_completed')
      .order('created_at', { ascending: true });

    if (evErr) throw evErr;

    // Group by tenant — build per-tenant timeline
    const byTenant = {};
    for (const e of (events || [])) {
      const tid = e.tenant_id;
      if (!byTenant[tid]) byTenant[tid] = {};
      const step = e.details?.step;
      if (step && !byTenant[tid][step]) {
        byTenant[tid][step] = e.created_at;
      }
    }

    const tenantCount = Object.keys(byTenant).length;

    // Count how many tenants completed each step
    const stepCounts = allStepKeys.map(key => {
      const completed = Object.values(byTenant).filter(steps => !!steps[key]).length;
      return { step: key, completed, pct: tenantCount > 0 ? Math.round((completed / tenantCount) * 100) : 0 };
    });

    // Compute drop-off between consecutive steps
    for (let i = 1; i < stepCounts.length; i++) {
      stepCounts[i].drop_off = stepCounts[i - 1].completed - stepCounts[i].completed;
    }
    stepCounts[0].drop_off = 0;

    // Per-tenant detail: which step they stopped at + time spent
    const tenants = Object.entries(byTenant).map(([tid, steps]) => {
      const completedSteps = allStepKeys.filter(k => !!steps[k]);
      const lastStep = completedSteps[completedSteps.length - 1] || null;
      const firstTs = steps[completedSteps[0]];
      const lastTs = steps[lastStep];
      const durationMin = firstTs && lastTs
        ? Math.round((new Date(lastTs) - new Date(firstTs)) / 60000)
        : 0;
      return {
        tenant_id: tid,
        steps_completed: completedSteps.length,
        last_step: lastStep,
        finished: completedSteps.includes('complete'),
        duration_minutes: durationMin,
      };
    });

    res.json({
      success: true,
      total_started: tenantCount,
      total_finished: tenants.filter(t => t.finished).length,
      completion_rate: tenantCount > 0
        ? Math.round((tenants.filter(t => t.finished).length / tenantCount) * 100) + '%'
        : '0%',
      funnel: stepCounts,
      tenants,
    });
  } catch (err) {
    log.error(`Wizard analytics failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/admin/onboarding — Active and recent onboardings
// ---------------------------------------------------------------------------
router.get('/onboarding', async (req, res) => {
  try {
    const db = getServiceClient();

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    // Tenants currently onboarding
    const { data: onboarding, error: onbErr } = await db
      .from('tenants')
      .select('id, name, slug, vertical, status, created_at')
      .eq('status', 'onboarding')
      .order('created_at', { ascending: false });

    if (onbErr) throw onbErr;

    // Recently created tenants (last 30 days) that are now active (completed onboarding)
    const { data: recent, error: recentErr } = await db
      .from('tenants')
      .select('id, name, slug, vertical, status, created_at')
      .eq('status', 'active')
      .gte('created_at', thirtyDaysAgo)
      .order('created_at', { ascending: false });

    if (recentErr) throw recentErr;

    res.json({
      success: true,
      active: onboarding || [],
      completed: recent || []
    });
  } catch (err) {
    log.error(`Admin onboarding failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/admin/onboard-tenant
 *
 * Manually provision a new tenant — for friends-and-family flows
 * where the customer isn't going through Stripe (think A Kut Above,
 * WellMor, etc). Does everything the Stripe checkout.session.completed
 * webhook would have done:
 *   1. Create tenant row + slug
 *   2. Enable picked modules in tenant_modules
 *   3. Persist tier + complimentary marker in tenant_config
 *   4. Create Supabase auth user (or attach to existing one) + send
 *      the dual-platform welcome wizard email (and SMS if configured)
 *
 * Auth: admin-only via the existing /api/admin middleware chain.
 *
 * Body:
 *   email *             — owner email
 *   owner_name *        — owner full name
 *   business_name *     — business name
 *   phone               — owner mobile
 *   tier                — 'growth' | 'scale' | 'complimentary' (default 'growth')
 *   modules[]           — module keys to enable (default: tier-appropriate set)
 *   vertical            — default 'home_services'
 *   is_complimentary    — true marks this as a friends-and-family tenant
 *   notes               — internal admin notes (stored in tenant_config)
 *   send_welcome        — bool, default true. False = create silently for testing.
 *
 * Returns: { success, tenant_id, slug, modules_enabled, welcome_sent }
 */
// Scale-tier full module list. voice_receptionist (Module 9, AI Voice
// Receptionist) is Scale-only — it replaced the retired social-engagement
// stub in slot 9 on 2026-05-17.
const SCALE_MODULES = [
  'lead_capture','speed_to_lead','missed_call','follow_up','content_engine',
  'approval_queue','review_request','branded_app','voice_receptionist',
  'referral_engine','referral_partners','prospecting',
  'lead_scoring','website','chat_agent',
];

// Modules a Growth-tier tenant can pick from (Growth = pick any 7 of 14).
// voice_receptionist is NOT in here — it's a Scale-only flagship.
const GROWTH_PICKABLE_MODULES = SCALE_MODULES.filter((m) => m !== 'voice_receptionist');

router.post('/onboard-tenant', async (req, res) => {
  try {
    const db = getServiceClient();
    const body = req.body || {};

    const email = String(body.email || '').trim().toLowerCase();
    const ownerName = String(body.owner_name || '').trim();
    const businessName = String(body.business_name || '').trim();
    if (!email || !ownerName || !businessName) {
      return res.status(400).json({
        success: false,
        error: 'email, owner_name, and business_name are required',
      });
    }

    const tier = ['growth', 'scale', 'complimentary'].includes(body.tier)
      ? body.tier : 'growth';
    const isComplimentary = !!body.is_complimentary || tier === 'complimentary';
    const phone = body.phone ? String(body.phone).trim() : null;
    const vertical = body.vertical ? String(body.vertical).trim() : 'home_services';
    const notes = body.notes ? String(body.notes).trim() : '';
    const sendWelcome = body.send_welcome !== false; // default true

    // Default modules by tier when none specified
    let modules = Array.isArray(body.modules) && body.modules.length
      ? body.modules
      : (tier === 'scale' || isComplimentary ? SCALE_MODULES : GROWTH_PICKABLE_MODULES.slice(0, 7));

    // Idempotency: refuse if a tenant with this owner_email exists
    const { data: existing } = await db
      .from('tenants').select('id, slug').eq('owner_email', email).maybeSingle();
    if (existing) {
      return res.status(409).json({
        success: false,
        error: `A tenant with email ${email} already exists`,
        tenant_id: existing.id,
        slug: existing.slug,
      });
    }

    // Generate a slug
    const slugBase = businessName.toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
    const slug = `${slugBase}-${Math.random().toString(36).slice(2, 7)}`;

    // Create the tenant
    const { data: tenant, error: createErr } = await db
      .from('tenants').insert({
        name: businessName,
        slug,
        owner_email: email,
        status: 'onboarding',
        vertical,
        is_demo: false,
      }).select().single();
    if (createErr) throw createErr;

    // Enable modules
    if (modules.length) {
      const moduleRows = modules.map((m) => ({
        tenant_id: tenant.id, module: m, enabled: true,
      }));
      const { error: modErr } = await db
        .from('tenant_modules').insert(moduleRows);
      if (modErr) log.warn(`tenant_modules insert warning: ${modErr.message}`);
    }

    // Persist tier + admin notes + complimentary marker in tenant_config
    const configRows = [
      { tenant_id: tenant.id, key: 'tier', value: tier },
      { tenant_id: tenant.id, key: 'owner_name', value: ownerName },
      { tenant_id: tenant.id, key: 'business_name', value: businessName },
      { tenant_id: tenant.id, key: 'owner_email', value: email },
      { tenant_id: tenant.id, key: 'is_complimentary', value: isComplimentary },
      { tenant_id: tenant.id, key: 'provisioned_via', value: 'admin_manual' },
      { tenant_id: tenant.id, key: 'provisioned_by_admin', value: req.user?.email || 'unknown' },
      { tenant_id: tenant.id, key: 'provisioned_at', value: new Date().toISOString() },
    ];
    if (phone) configRows.push({ tenant_id: tenant.id, key: 'phone', value: phone });
    if (notes) configRows.push({ tenant_id: tenant.id, key: 'admin_notes', value: notes });

    await db.from('tenant_config').upsert(configRows, { onConflict: 'tenant_id,key' });

    // Send the welcome wizard (creates Supabase auth user, generates
    // magic links, sends email + optional SMS).
    let welcome_sent = false;
    if (sendWelcome) {
      try {
        const { sendWelcomeWizard } = require('../../core/welcome-wizard');
        await sendWelcomeWizard(db, {
          tenantId: tenant.id,
          email,
          ownerName,
          businessName,
          phone,
        });
        welcome_sent = true;
      } catch (welcomeErr) {
        log.error(`sendWelcomeWizard failed for tenant ${tenant.id}: ${welcomeErr.message}`);
      }
    }

    log.info(
      `Admin manually onboarded tenant ${tenant.id} (${businessName} <${email}>) — ` +
      `tier=${tier}, modules=${modules.length}, complimentary=${isComplimentary}, welcome_sent=${welcome_sent}`,
    );

    res.json({
      success: true,
      tenant_id: tenant.id,
      slug: tenant.slug,
      modules_enabled: modules.length,
      welcome_sent,
      is_complimentary: isComplimentary,
    });
  } catch (err) {
    log.error(`onboard-tenant failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/admin/clients/:tenantId/resend-welcome
 *
 * Re-fires the welcome-wizard email for a tenant. Useful when the
 * original magic link expired, the customer can't find the original
 * email, or Patrick wants to test the flow.
 *
 * Calls the same sendWelcomeWizard core function the Stripe webhook
 * and manual onboard endpoint use — fresh magic links are minted on
 * every call. Idempotent at the auth layer (Supabase reuses the
 * existing user; just rotates link tokens).
 */
router.post('/clients/:tenantId/resend-welcome', async (req, res) => {
  try {
    const db = getServiceClient();
    const { tenantId } = req.params;

    const { data: tenant, error: tErr } = await db
      .from('tenants').select('*').eq('id', tenantId).maybeSingle();
    if (tErr || !tenant) {
      return res.status(404).json({ success: false, error: 'Tenant not found' });
    }

    const { data: configRows } = await db
      .from('tenant_config').select('key, value').eq('tenant_id', tenantId);
    const config = {};
    for (const r of configRows || []) config[r.key] = r.value;

    const email = tenant.owner_email || config.owner_email;
    if (!email) {
      return res.status(400).json({ success: false, error: 'No owner_email on tenant' });
    }

    const { sendWelcomeWizard } = require('../../core/welcome-wizard');
    await sendWelcomeWizard(db, {
      tenantId,
      email,
      ownerName: config.owner_name,
      businessName: tenant.name,
      phone: config.phone,
    });

    log.info(`Admin resent welcome wizard for tenant ${tenantId} → ${email}`);
    res.json({ success: true, sent_to: email });
  } catch (err) {
    log.error(`resend-welcome failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/admin/clients/:tenantId/refire-pipeline
 *
 * Queues a fresh app-asset-pipeline job for a tenant. Used when the
 * first pipeline run failed, or when Patrick wants to regenerate the
 * branded app assets after a brand-color or logo change.
 */
router.post('/clients/:tenantId/refire-pipeline', async (req, res) => {
  try {
    const db = getServiceClient();
    const { tenantId } = req.params;

    const { data: tenant } = await db.from('tenants').select('id, slug').eq('id', tenantId).maybeSingle();
    if (!tenant) {
      return res.status(404).json({ success: false, error: 'Tenant not found' });
    }

    const { data: configRows } = await db
      .from('tenant_config').select('key, value').eq('tenant_id', tenantId).eq('key', 'delivery_path').maybeSingle();
    const deliveryPath = configRows?.value || 'managed';

    const { error: jobErr } = await db.from('agent_jobs').insert({
      tenant_id: tenantId,
      agent_name: 'app-asset-pipeline',
      status: 'pending',
      priority: 5,
      payload: {
        trigger: 'admin_refire',
        delivery_path: deliveryPath,
        tenant_slug: tenant.slug,
        triggered_by: req.user?.email || 'unknown',
      },
    });
    if (jobErr) throw jobErr;

    log.info(`Admin re-queued app-asset-pipeline for tenant ${tenantId}`);
    res.json({ success: true, queued: true });
  } catch (err) {
    log.error(`refire-pipeline failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/admin/clients/:tenantId/rebuild-website
 *
 * V1 hardening (2026-05-24): queues a fresh dfy-website-build job for a
 * tenant. Used when:
 *   - The chat widget needs to embed a fresh widget_token (after
 *     CHAT_WIDGET_SECRET rotation OR for any site built before the
 *     widget-token hardening shipped — see chat-widget-token.js).
 *   - Branding / copy / services config changed and the site needs to
 *     re-render.
 *
 * Skipped silently if the tenant doesn't have the website module enabled.
 */
router.post('/clients/:tenantId/rebuild-website', async (req, res) => {
  try {
    const db = getServiceClient();
    const { tenantId } = req.params;

    const { data: tenant } = await db.from('tenants').select('id, slug').eq('id', tenantId).maybeSingle();
    if (!tenant) {
      return res.status(404).json({ success: false, error: 'Tenant not found' });
    }

    // Confirm the tenant actually has the website module enabled —
    // refusing a no-op enqueue keeps agent_jobs clean.
    const { data: mod } = await db.from('tenant_modules')
      .select('enabled')
      .eq('tenant_id', tenantId)
      .eq('module', 'website')
      .maybeSingle();
    if (!mod?.enabled) {
      return res.status(400).json({ success: false, error: 'Website module is not enabled for this tenant' });
    }

    const { error: jobErr } = await db.from('agent_jobs').insert({
      tenant_id: tenantId,
      agent_name: 'dfy-website-build',
      status: 'pending',
      priority: 5,
      payload: {
        trigger: 'admin_rebuild',
        tenant_slug: tenant.slug,
        triggered_by: req.user?.email || 'unknown',
        reason: req.body?.reason || 'admin_initiated',
      },
    });
    if (jobErr) throw jobErr;

    log.info(`Admin re-queued dfy-website-build for tenant ${tenantId} (reason=${req.body?.reason || 'admin_initiated'})`);
    res.json({ success: true, queued: true });
  } catch (err) {
    log.error(`rebuild-website failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/admin/clients/:tenantId/switch-path
 *
 * Switch a tenant between managed and owned delivery paths within
 * the 30-day grace window. Updates tenant_config.delivery_path,
 * clears apple_enrollment_email_sent_at if going managed → owned
 * (so the email re-fires from the next path_choice save), and logs
 * the switch.
 *
 * Body: { delivery_path: 'managed' | 'owned' }
 */
router.post('/clients/:tenantId/switch-path', async (req, res) => {
  try {
    const db = getServiceClient();
    const { tenantId } = req.params;
    const newPath = req.body?.delivery_path;
    if (!['managed', 'owned'].includes(newPath)) {
      return res.status(400).json({ success: false, error: 'delivery_path must be managed or owned' });
    }

    const { data: tenant } = await db
      .from('tenants').select('id, created_at').eq('id', tenantId).maybeSingle();
    if (!tenant) return res.status(404).json({ success: false, error: 'Tenant not found' });

    // Soft 30-day check (warn but allow Patrick to override)
    const ageDays = (Date.now() - new Date(tenant.created_at).getTime()) / 86400000;
    const beyondGrace = ageDays > 30;

    const upserts = [
      { tenant_id: tenantId, key: 'delivery_path', value: newPath },
      { tenant_id: tenantId, key: 'delivery_path_switched_at', value: new Date().toISOString() },
      { tenant_id: tenantId, key: 'delivery_path_switched_by', value: req.user?.email || 'admin' },
    ];

    // If switching INTO owned, clear the apple-enrollment marker so
    // the email refires when the customer re-saves path_choice in
    // the wizard (or admin can call resend-apple-enrollment).
    if (newPath === 'owned') {
      upserts.push({ tenant_id: tenantId, key: 'apple_enrollment_email_sent_at', value: null });
    }

    await db.from('tenant_config').upsert(upserts, { onConflict: 'tenant_id,key' });

    log.info(`Admin switched tenant ${tenantId} → delivery_path=${newPath} (tenant age ${ageDays.toFixed(1)} days)`);
    res.json({
      success: true,
      delivery_path: newPath,
      beyond_30day_grace: beyondGrace,
      tenant_age_days: ageDays.toFixed(1),
    });
  } catch (err) {
    log.error(`switch-path failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Support inbox endpoints — read threads, view messages, reply via Resend,
// change thread status. Tables: support_threads + support_messages
// (migration 020). Inbound population is handled by a separate webhook
// worker; until that lands these endpoints simply return empty results.
// ---------------------------------------------------------------------------

router.get('/support/threads', async (req, res) => {
  try {
    const db = getServiceClient();
    const status = (req.query.status || 'open').toString();
    let query = db
      .from('support_threads')
      .select('id, from_name, from_email, subject, status, last_message_at, tenant_id')
      .order('last_message_at', { ascending: false })
      .limit(100);
    if (status !== 'all') query = query.eq('status', status);
    const { data, error } = await query;
    if (error) {
      // If the table doesn't exist yet (migration not applied), return empty
      // gracefully rather than 500.
      if (/relation .* does not exist/i.test(error.message)) {
        return res.json({ success: true, threads: [] });
      }
      throw error;
    }

    // Attach tenant name + message count + preview.
    const threadIds = (data || []).map(t => t.id);
    const tenantIds = (data || []).map(t => t.tenant_id).filter(Boolean);
    const [tenantsRes, countsRes] = await Promise.all([
      tenantIds.length
        ? db.from('tenants').select('id, name').in('id', tenantIds)
        : Promise.resolve({ data: [] }),
      threadIds.length
        ? db.from('support_messages').select('thread_id, body').in('thread_id', threadIds).order('created_at', { ascending: false })
        : Promise.resolve({ data: [] }),
    ]);
    const tenantNameById = {};
    for (const t of (tenantsRes.data || [])) tenantNameById[t.id] = t.name;
    const previewByThread = {};
    const countByThread = {};
    for (const m of (countsRes.data || [])) {
      countByThread[m.thread_id] = (countByThread[m.thread_id] || 0) + 1;
      if (!previewByThread[m.thread_id] && m.body) {
        previewByThread[m.thread_id] = m.body.slice(0, 140);
      }
    }
    const threads = (data || []).map(t => ({
      ...t,
      tenant_name: t.tenant_id ? tenantNameById[t.tenant_id] : undefined,
      message_count: countByThread[t.id] || 0,
      preview: previewByThread[t.id] || '',
    }));
    res.json({ success: true, threads });
  } catch (err) {
    log.error(`support threads list failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/support/threads/:threadId/messages', async (req, res) => {
  try {
    const db = getServiceClient();
    const { threadId } = req.params;
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
    log.error(`support messages list failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/support/threads/:threadId/reply', async (req, res) => {
  try {
    const db = getServiceClient();
    const { threadId } = req.params;
    const body = (req.body?.body || '').toString().trim();
    if (!body) return res.status(400).json({ success: false, error: 'body required' });

    // Fetch the thread to know who we're replying to + the subject.
    const { data: thread, error: threadErr } = await db
      .from('support_threads')
      .select('id, from_email, subject, status')
      .eq('id', threadId)
      .maybeSingle();
    if (threadErr) throw threadErr;
    if (!thread) return res.status(404).json({ success: false, error: 'Thread not found' });

    // Send via Resend.
    const { sendEmail } = require('../../integrations/email');
    const replySubject = thread.subject && /^re:/i.test(thread.subject)
      ? thread.subject
      : `Re: ${thread.subject || 'your support request'}`;
    const html = body.replace(/\n/g, '<br>');
    const sendResult = await sendEmail(thread.from_email, replySubject, html, {
      from: 'support@firstgenautomate.com',
    });

    // Persist the outbound message + bump thread.
    await db.from('support_messages').insert({
      thread_id: threadId,
      direction: 'outbound',
      from_email: 'support@firstgenautomate.com',
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
    log.error(`support reply failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.patch('/support/threads/:threadId', async (req, res) => {
  try {
    const db = getServiceClient();
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
      .eq('id', threadId);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    log.error(`support thread update failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Content generation: request a post with a specific format ──────────────
router.post('/content/generate', async (req, res) => {
  try {
    const db = getServiceClient();
    const { format_id, custom_prompt, platform } = req.body || {};
    if (!format_id || !Number.isFinite(Number(format_id))) {
      return res.status(400).json({ success: false, error: 'format_id is required (1-9)' });
    }
    const payload = {
      format_id: Number(format_id),
      platform: platform || 'instagram',
    };
    if (custom_prompt && typeof custom_prompt === 'string' && custom_prompt.trim()) {
      payload.custom_prompt = custom_prompt.trim();
    }
    const { data: job, error } = await db.from('agent_jobs').insert({
      tenant_id: FGA_TENANT_ID,
      agent_name: 'content-generation',
      payload,
      status: 'pending',
    }).select('id').single();
    if (error) throw error;
    log.success(`Queued content-generation job ${job.id} (format ${format_id})`);
    res.json({ success: true, job_id: job.id });
  } catch (err) {
    log.error(`content generate failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
