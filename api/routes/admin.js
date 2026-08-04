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
const { isBillingActive, classifyTenant } = require('../../core/revenue');
const { INCOME_SOURCES, classifyIncome, normalizeCategory } = require('../../core/finance-categories');
const { resolveTenant } = require('../../core/tenant');
const { applyPlainSignature, applyHtmlSignature } = require('../../core/email-signature');

// V1 hardening (2026-05-24): pure helpers extracted to ./admin/_helpers.js
// as precondition for per-domain file split (V1.1). Behavior identical.
const { TIER_PRICING, SETUP_FEE_DEFAULT, readNumericConfig } = require('./admin/_helpers');

/**
 * Count FGA email outreach drafts that genuinely need Patrick's review.
 *
 * The predicate itself now lives in core/growth/review-queue.js, shared with
 * the Review Queue page that this count links to (2026-07-24). Keeping one
 * definition is the point: the alert said one number, the page it linked to
 * showed something else, and Patrick had to reconcile them by hand.
 *
 * Returns { count }. Fails closed to { count: 0 } on any error.
 */
const { countReviewableDrafts } = require('../../core/growth/review-queue');
const countNewLeadEmailDrafts = countReviewableDrafts;

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

    // Calculate MRR billing-aware (core/revenue.js) across ALL non-demo,
    // non-internal tenants — not just operationally-active ones. A tenant
    // still onboarding can already be billing (923A). This keeps the
    // overview MRR identical to dashboard-summary and finance/report.
    let mrr = 0;
    try {
      const { data: mrrTenants } = await db
        .from('tenants')
        .select('id, name, slug, status, is_demo');
      const mrrIds = (mrrTenants || []).map((t) => t.id);
      const { data: mrrCfg } = mrrIds.length
        ? await db.from('tenant_config').select('tenant_id, key, value')
            .in('tenant_id', mrrIds)
            .in('key', ['tier', 'monthly_rate', 'is_complimentary', 'billing_active',
              'subscription_status', 'trial_ends_at', 'churned_at'])
        : { data: [] };
      for (const t of mrrTenants || []) {
        const c = classifyTenant(
          t,
          (key) => (mrrCfg || []).find((r) => r.tenant_id === t.id && r.key === key)?.value,
          FGA_TENANT_ID,
        );
        if (c.type === 'paying') mrr += c.monthly_rate;
      }
    } catch (_) {
      // Fallback to the legacy sum if the classification query fails.
      for (const t of tenantStats) mrr += t.monthly_rate;
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
// Payload trim (2026-07-21, Patrick-approved): this endpoint served ~4MB —
// select('*') dragged every lead's enrichment metadata blob and every
// sequence's full body into the LIST payload, which is what made the
// Pipeline page take ~17s. The list now carries exactly the fields the UI
// reads (plus campaign_id extracted from metadata — the only key the UI
// uses) and a 400-char draft preview; LeadDetail still fetches full bodies
// via /pipeline/:id and /pipeline/:id/outreach.
const PIPELINE_LEAD_COLUMNS = [
  'id', 'name', 'company_name', 'email', 'phone', 'service_type', 'industry',
  'city', 'hq_state', 'lead_source', 'lead_score', 'priority_tier', 'website',
  'status', 'lifecycle_stage', 'enrichment_status', 'outreach_ready',
  'automation_status', 'notes', 'created_at', 'updated_at',
  'next_best_action', 'next_action_owner', 'next_action_due_at',
  'human_handoff_reason', 'sales_call_status',
].join(', ');
const DRAFT_PREVIEW_CHARS = 400;

router.get('/pipeline', async (req, res) => {
  try {
    const db = getServiceClient();

    const { data: leads, error } = await db
      .from('leads')
      .select(`${PIPELINE_LEAD_COLUMNS}, campaign_id:metadata->>campaign_id`)
      .eq('tenant_id', FGA_TENANT_ID)
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Batch-fetch the latest outreach sequence for each lead so the
    // pipeline list can show a draft preview without N+1 API calls.
    const leadIds = (leads || []).map(l => l.id);
    let outreachMap = {};
    let fbDmMap = {};
    if (leadIds.length > 0) {
      // NOTE: do NOT `.in('lead_id', leadIds)` here. `leads` is EVERY lead for
      // this tenant, so every sequence already belongs to one of them — the
      // filter is redundant. Worse, it inlines all ~450 UUIDs into the request
      // URL (~17KB), which the proxy rejects (414) once the lead count grows.
      // The error was swallowed (`const { data }` ignores `error`), so every
      // lead silently got outreach_draft=null and the entire "Drafts to Review"
      // queue read 0 — no drafts to open, no way to manually approve/send.
      // tenant_id scope + a generous limit is correct and scales.
      const { data: sequences, error: seqErr } = await db
        .from('outreach_sequences')
        .select('id, lead_id, sequence_status, sequence_type, message_subject, message_body, created_at')
        .eq('tenant_id', FGA_TENANT_ID)
        .order('created_at', { ascending: false })
        .limit(5000);
      if (seqErr) log.error(`pipeline sequences fetch failed: ${seqErr.message}`);

      // Keep the most recent EMAIL sequence per lead, falling back to the
      // most recent of any type only when no email sequence exists. This
      // matches the /pipeline/:leadId/outreach detail endpoint, which also
      // prefers email (the auto-sendable channel). Without the preference,
      // a newer facebook_dm backup draft hides the sendable email draft
      // from the list payload — breaking the "Draft ready" badge and
      // bulk-send eligibility (2026-06-09).
      const fallbackMap = {};
      for (const seq of (sequences || [])) {
        if (seq.sequence_type === 'email') {
          if (!outreachMap[seq.lead_id]) outreachMap[seq.lead_id] = seq;
        } else if (!fallbackMap[seq.lead_id]) {
          fallbackMap[seq.lead_id] = seq;
        }
      }
      for (const [fbLeadId, seq] of Object.entries(fallbackMap)) {
        if (!outreachMap[fbLeadId]) outreachMap[fbLeadId] = seq;
      }

      // 2026-05-27: also batch-fetch the latest outbound facebook_dm
      // conversation per lead so the pipeline UI can render Open / Copy
      // / Open+Copy quick actions on fb_only cards. Includes metadata
      // (facebook_url + draft_status) for the workflow buttons.
      // Same as above: tenant scope, not a 450-UUID .in() that 414s the URL.
      const { data: fbConvs, error: fbErr } = await db
        .from('conversations')
        .select('id, lead_id, channel, direction, message_body, metadata, created_at')
        .eq('tenant_id', FGA_TENANT_ID)
        .eq('channel', 'facebook_dm')
        .eq('direction', 'outbound')
        .order('created_at', { ascending: false })
        .limit(5000);
      if (fbErr) log.error(`pipeline fb conversations fetch failed: ${fbErr.message}`);
      for (const c of (fbConvs || [])) {
        if (!fbDmMap[c.lead_id]) fbDmMap[c.lead_id] = c;
      }
    }

    // Attach outreach_draft + fb_dm_draft to each lead. Email draft bodies
    // are trimmed to a preview (the card shows ~5 lines; LeadDetail fetches
    // the full body for editing). FB DM bodies stay WHOLE — the "Copy DM"
    // quick action copies message_body verbatim, so truncating it would
    // corrupt what gets pasted into Messenger. The UI reads campaign_id from
    // lead.metadata, so rebuild that slim shape from the extracted column.
    const preview = (seq) => {
      if (!seq || !seq.message_body || seq.message_body.length <= DRAFT_PREVIEW_CHARS) return seq;
      return {
        ...seq,
        message_body: seq.message_body.slice(0, DRAFT_PREVIEW_CHARS) + '…',
        body_truncated: true,
      };
    };
    const leadsWithOutreach = (leads || []).map(({ campaign_id, ...l }) => ({
      ...l,
      metadata: campaign_id ? { campaign_id } : {},
      outreach_draft: preview(outreachMap[l.id] || null),
      fb_dm_draft: fbDmMap[l.id] || null,
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
// Pipeline enhancement endpoints (2026-06-09).
// NOTE: the literal routes (/pipeline/tasks, /pipeline/duplicates,
// /pipeline/merge) MUST be registered before /pipeline/:leadId or Express
// will capture "tasks" as a leadId.
// ---------------------------------------------------------------------------

// Audit-trail helper — every admin mutation on a pipeline lead writes a row
// to the existing activity_log table so the lead drawer can show a true
// "who did what when" history alongside conversations.
async function logLeadActivity(db, action, leadId, metadata = {}) {
  try {
    await db.from('activity_log').insert({
      tenant_id: FGA_TENANT_ID,
      agent: 'admin',
      action,
      entity_type: 'lead',
      entity_id: leadId,
      level: 'info',
      metadata,
    });
  } catch (e) {
    log.warn(`activity_log write failed (${action}): ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// GET /api/admin/pipeline/tasks — All follow-up tasks for FGA's pipeline.
// Open tasks first (soonest due at top), plus tasks completed in the last
// 7 days so "done" items don't vanish instantly.
// ---------------------------------------------------------------------------
router.get('/pipeline/tasks', async (req, res) => {
  try {
    const db = getServiceClient();
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data: tasks, error } = await db
      .from('lead_tasks')
      .select('*, leads(id, company_name, name, status)')
      .eq('tenant_id', FGA_TENANT_ID)
      .or(`status.eq.open,completed_at.gte.${weekAgo}`)
      .order('due_at', { ascending: true, nullsFirst: false });
    if (error) throw error;
    res.json({ success: true, tasks: tasks || [] });
  } catch (err) {
    log.error(`Pipeline tasks list failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/admin/pipeline/tasks/:taskId — Edit / complete / reopen a task
// ---------------------------------------------------------------------------
router.patch('/pipeline/tasks/:taskId', async (req, res) => {
  try {
    const db = getServiceClient();
    const { taskId } = req.params;
    const updates = { updated_at: new Date().toISOString() };
    if (req.body.title !== undefined) updates.title = req.body.title;
    if (req.body.due_at !== undefined) updates.due_at = req.body.due_at;
    if (req.body.status !== undefined) {
      if (!['open', 'done'].includes(req.body.status)) {
        return res.status(400).json({ success: false, error: 'status must be open or done' });
      }
      updates.status = req.body.status;
      updates.completed_at = req.body.status === 'done' ? new Date().toISOString() : null;
    }
    const { data: task, error } = await db
      .from('lead_tasks')
      .update(updates)
      .eq('id', taskId)
      .eq('tenant_id', FGA_TENANT_ID)
      .select()
      .single();
    if (error) throw error;
    if (updates.status === 'done') {
      await logLeadActivity(db, 'task_completed', task.lead_id, { task_id: task.id, title: task.title });
    }
    res.json({ success: true, task });
  } catch (err) {
    log.error(`Pipeline task update failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/admin/pipeline/tasks/:taskId — Remove a task
// ---------------------------------------------------------------------------
router.delete('/pipeline/tasks/:taskId', async (req, res) => {
  try {
    const db = getServiceClient();
    const { error } = await db
      .from('lead_tasks')
      .delete()
      .eq('id', req.params.taskId)
      .eq('tenant_id', FGA_TENANT_ID);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    log.error(`Pipeline task delete failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ===========================================================================
// UNIFIED TASKS (2026-06-13)
//
// Generalizes lead_tasks into a portal-wide task model. The same table now
// carries a related_type/related_id (lead, client, onboarding, support,
// agent, campaign, drip, content, expense, revenue, integration, general)
// plus priority, assignee, source, description and completion notes. Existing
// lead tasks + the /pipeline/tasks endpoints keep working unchanged; these
// /tasks endpoints are the generalized surface used by the Tasks page and the
// Operations Center aggregation. Always FGA-scoped (platform-owner tooling).
// ===========================================================================

const TASK_RELATED_TYPES = ['lead', 'client', 'onboarding', 'support', 'agent', 'campaign', 'drip', 'content', 'expense', 'revenue', 'integration', 'general'];
const TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'];

// Drill-down route for a task's related record (used by the UI "Open" action).
function taskRelatedLink(t) {
  switch (t.related_type) {
    case 'lead': return t.related_id ? `/admin/pipeline/${t.related_id}` : '/admin/pipeline';
    case 'client': return '/admin/clients';
    case 'onboarding': return '/admin/onboarding';
    case 'support': return '/admin/support';
    case 'agent': return '/admin/agent-hub';
    case 'campaign': return t.related_id ? `/admin/targeted-campaigns/${t.related_id}` : '/admin/targeted-campaigns';
    case 'drip': return '/admin/drip-campaign';
    case 'content': return '/admin/content';
    case 'expense': return '/admin/expenses';
    case 'revenue': return '/admin/finance';
    case 'integration': return '/admin/integrations';
    default: return null;
  }
}

async function logTaskActivity(db, action, task, extra = {}) {
  try {
    await db.from('activity_log').insert({
      tenant_id: FGA_TENANT_ID,
      agent: 'admin',
      action,
      entity_type: task.related_type || 'task',
      entity_id: task.related_id || task.id,
      level: 'info',
      metadata: { task_id: task.id, title: task.title, priority: task.priority, ...extra },
    });
  } catch (e) {
    log.warn(`task activity_log write failed (${action}): ${e.message}`);
  }
}

// Enrich lead tasks with the company/contact name for display.
async function attachTaskLabels(db, tasks) {
  const leadIds = [...new Set(tasks.filter(t => t.related_type === 'lead' && t.related_id).map(t => t.related_id))];
  let leadMap = {};
  if (leadIds.length) {
    const { data: leads } = await db.from('leads')
      .select('id, company_name, name')
      .eq('tenant_id', FGA_TENANT_ID).in('id', leadIds);
    for (const l of (leads || [])) leadMap[l.id] = l.company_name || l.name;
  }
  return tasks.map(t => ({
    ...t,
    related_label: t.related_label || (t.related_type === 'lead' ? (leadMap[t.related_id] || null) : null),
    related_link: taskRelatedLink(t),
  }));
}

// GET /api/admin/tasks?view=&assignee=&priority=&related_type=
// view: all (default) | open | due_today | overdue | upcoming | completed | mine
router.get('/tasks', async (req, res) => {
  try {
    const db = getServiceClient();
    const { view = 'all', assignee, priority, related_type } = req.query;
    let q = db.from('lead_tasks').select('*').eq('tenant_id', FGA_TENANT_ID);
    if (assignee) q = q.eq('assigned_to', assignee);
    if (priority) q = q.eq('priority', priority);
    if (related_type) q = q.eq('related_type', related_type);

    const now = new Date();
    const endToday = new Date(now); endToday.setHours(23, 59, 59, 999);
    if (view === 'completed') q = q.eq('status', 'done');
    else if (view === 'open') q = q.eq('status', 'open');
    else if (view === 'overdue') q = q.eq('status', 'open').lt('due_at', now.toISOString());
    else if (view === 'due_today') q = q.eq('status', 'open').gte('due_at', now.toISOString()).lte('due_at', endToday.toISOString());
    else if (view === 'upcoming') q = q.eq('status', 'open').gt('due_at', endToday.toISOString());

    q = q.order('status', { ascending: true }).order('due_at', { ascending: true, nullsFirst: false }).limit(500);
    const { data, error } = await q;
    if (error) throw error;
    const tasks = await attachTaskLabels(db, data || []);

    // Lightweight counts for the view tabs.
    const { data: all } = await db.from('lead_tasks').select('status, due_at').eq('tenant_id', FGA_TENANT_ID);
    const counts = { all: 0, open: 0, due_today: 0, overdue: 0, upcoming: 0, completed: 0 };
    for (const t of (all || [])) {
      counts.all++;
      if (t.status === 'done') { counts.completed++; continue; }
      counts.open++;
      if (t.due_at) {
        const d = new Date(t.due_at);
        if (d < now) counts.overdue++;
        else if (d <= endToday) counts.due_today++;
        else counts.upcoming++;
      }
    }
    res.json({ success: true, tasks, counts });
  } catch (err) {
    log.error(`Tasks list failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/admin/tasks — create a task on any related record (or general).
router.post('/tasks', async (req, res) => {
  try {
    const db = getServiceClient();
    const b = req.body || {};
    if (!b.title || !b.title.trim()) return res.status(400).json({ success: false, error: 'title required' });
    const related_type = TASK_RELATED_TYPES.includes(b.related_type) ? b.related_type : 'general';
    const priority = TASK_PRIORITIES.includes(b.priority) ? b.priority : 'normal';
    const row = {
      tenant_id: FGA_TENANT_ID,
      title: b.title.trim(),
      description: b.description || null,
      related_type,
      related_id: b.related_id || null,
      related_label: b.related_label || null,
      // keep legacy lead_id in sync for backward compatibility
      lead_id: related_type === 'lead' ? (b.related_id || null) : null,
      due_at: b.due_at || null,
      priority,
      assigned_to: b.assigned_to || 'owner',
      source: b.source || 'manual',
      status: 'open',
    };
    const { data: task, error } = await db.from('lead_tasks').insert(row).select().single();
    if (error) throw error;
    await logTaskActivity(db, 'task_created', task);
    res.json({ success: true, task });
  } catch (err) {
    log.error(`Task create failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /api/admin/tasks/:id — edit / complete / reopen / reschedule / reassign / priority / note
router.patch('/tasks/:id', async (req, res) => {
  try {
    const db = getServiceClient();
    const b = req.body || {};
    const updates = { updated_at: new Date().toISOString() };
    if (b.title !== undefined) updates.title = b.title;
    if (b.description !== undefined) updates.description = b.description;
    if (b.due_at !== undefined) updates.due_at = b.due_at;
    if (b.assigned_to !== undefined) updates.assigned_to = b.assigned_to;
    if (b.completion_notes !== undefined) updates.completion_notes = b.completion_notes;
    if (b.priority !== undefined) {
      if (!TASK_PRIORITIES.includes(b.priority)) return res.status(400).json({ success: false, error: 'invalid priority' });
      updates.priority = b.priority;
    }
    if (b.status !== undefined) {
      if (!['open', 'done'].includes(b.status)) return res.status(400).json({ success: false, error: 'status must be open or done' });
      updates.status = b.status;
      updates.completed_at = b.status === 'done' ? new Date().toISOString() : null;
    }
    const { data: task, error } = await db.from('lead_tasks')
      .update(updates).eq('id', req.params.id).eq('tenant_id', FGA_TENANT_ID).select().single();
    if (error) throw error;
    if (updates.status === 'done') await logTaskActivity(db, 'task_completed', task);
    else if (updates.status === 'open') await logTaskActivity(db, 'task_reopened', task);
    res.json({ success: true, task });
  } catch (err) {
    log.error(`Task update failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/admin/tasks/:id
router.delete('/tasks/:id', async (req, res) => {
  try {
    const db = getServiceClient();
    const { error } = await db.from('lead_tasks').delete().eq('id', req.params.id).eq('tenant_id', FGA_TENANT_ID);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    log.error(`Task delete failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ===========================================================================
// USAGE & COSTS (2026-06-13)
// Aggregates the ai_usage_events ledger (provider/agent/model cost + tokens)
// into this-month vs last-month totals + provider/agent/model breakdowns +
// recent errors. Reads only — does NOT make any provider calls (respects the
// global pace gate / API safety architecture). FGA-scoped.
// ===========================================================================
router.get('/usage', async (req, res) => {
  try {
    const db = getServiceClient();
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);

    // Platform-owner cost view: FGA owns ALL provider API keys, so every AI
    // call is FGA's spend regardless of which tenant (or none) it was attributed
    // to. We intentionally do NOT filter by tenant_id — the prior FGA-only
    // filter hid the bulk of usage (outreach, enrichment, etc.) which logs with
    // a NULL tenant_id, making the page read ~$0.12 instead of the real total.
    const { data: rows, error } = await db
      .from('ai_usage_events')
      .select('provider, model, agent_name, estimated_cost_usd, input_tokens, output_tokens, outcome, untracked, created_at')
      .gte('created_at', prevMonthStart.toISOString())
      .order('created_at', { ascending: false })
      .limit(50000);
    if (error) throw error;

    const blank = () => ({ cost: 0, events: 0, input: 0, output: 0, errors: 0 });
    const cur = blank(), prev = blank();
    const byProvider = {}, byAgent = {}, byModel = {};
    const recentErrors = [];
    for (const r of (rows || [])) {
      const inCur = new Date(r.created_at) >= monthStart;
      const bucket = inCur ? cur : prev;
      const cost = Number(r.estimated_cost_usd || 0);
      bucket.cost += cost; bucket.events += 1;
      bucket.input += (r.input_tokens || 0); bucket.output += (r.output_tokens || 0);
      const isErr = r.outcome && !['success', 'ok', 'completed'].includes(String(r.outcome).toLowerCase());
      if (isErr) bucket.errors += 1;
      if (inCur) {
        const p = r.provider || 'unknown';
        const a = r.agent_name || 'unattributed';
        const m = r.model || 'unknown';
        (byProvider[p] = byProvider[p] || blank()); byProvider[p].cost += cost; byProvider[p].events += 1; byProvider[p].input += (r.input_tokens || 0); byProvider[p].output += (r.output_tokens || 0); if (isErr) byProvider[p].errors += 1;
        (byAgent[a] = byAgent[a] || blank()); byAgent[a].cost += cost; byAgent[a].events += 1; if (isErr) byAgent[a].errors += 1;
        (byModel[m] = byModel[m] || blank()); byModel[m].cost += cost; byModel[m].events += 1;
        if (isErr && recentErrors.length < 15) recentErrors.push({ provider: r.provider, agent: r.agent_name, model: r.model, outcome: r.outcome, at: r.created_at });
      }
    }
    const toList = (obj) => Object.entries(obj).map(([key, v]) => ({ key, ...v, cost: Math.round(v.cost * 10000) / 10000 })).sort((a, b) => b.cost - a.cost || b.events - a.events);

    // Safety switches (kill switches / circuit breakers) — fail-open if absent.
    let switches = [];
    try {
      const { data: sw } = await db.from('ai_safety_switches').select('*').limit(50);
      switches = (sw || []).map(s => ({ key: s.key || s.name || s.id, enabled: s.enabled ?? s.value ?? null, updated_at: s.updated_at }));
    } catch { /* table optional */ }

    res.json({
      success: true,
      generated_at: now.toISOString(),
      current_month: { ...cur, cost: Math.round(cur.cost * 100) / 100 },
      previous_month: { ...prev, cost: Math.round(prev.cost * 100) / 100 },
      by_provider: toList(byProvider),
      by_agent: toList(byAgent),
      by_model: toList(byModel),
      recent_errors: recentErrors,
      switches,
    });
  } catch (err) {
    log.error(`Usage aggregation failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/admin/pipeline/duplicates — Candidate duplicate groups.
// Pure detection, NO auto-merge. Groups leads that share a normalized
// email, a 10+ digit phone, or a normalized company name. The owner
// reviews each group and merges manually via POST /pipeline/merge.
// ---------------------------------------------------------------------------
router.get('/pipeline/duplicates', async (req, res) => {
  try {
    const db = getServiceClient();
    const { data: leads, error } = await db
      .from('leads')
      .select('id, name, company_name, email, phone, city, hq_state, status, lifecycle_stage, lead_source, created_at')
      .eq('tenant_id', FGA_TENANT_ID);
    if (error) throw error;

    const normCompany = (s) => (s || '')
      .toLowerCase()
      .replace(/\b(llc|inc|co|corp|ltd|company|services?|the)\b/g, '')
      .replace(/[^a-z0-9]/g, '');
    const normPhone = (s) => {
      const d = (s || '').replace(/\D/g, '');
      return d.length >= 10 ? d.slice(-10) : null;
    };

    // Build match-key → lead-ids maps for the three signals
    const buckets = {}; // key → { reason, ids:Set }
    const add = (key, reason, id) => {
      if (!key) return;
      const k = `${reason}:${key}`;
      if (!buckets[k]) buckets[k] = { reason, ids: new Set() };
      buckets[k].ids.add(id);
    };
    for (const l of leads || []) {
      add((l.email || '').trim().toLowerCase() || null, 'email', l.id);
      add(normPhone(l.phone), 'phone', l.id);
      const nc = normCompany(l.company_name);
      add(nc.length >= 4 ? nc : null, 'company', l.id);
    }

    // Union overlapping groups so a pair matching on email AND phone shows once
    const parent = {};
    const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
    const union = (a, b) => { parent[find(a)] = find(b); };
    for (const l of leads || []) parent[l.id] = l.id;
    const reasonsByLead = {};
    for (const { reason, ids } of Object.values(buckets)) {
      const arr = Array.from(ids);
      if (arr.length < 2) continue;
      for (let i = 1; i < arr.length; i++) union(arr[0], arr[i]);
      for (const id of arr) {
        reasonsByLead[id] = reasonsByLead[id] || new Set();
        reasonsByLead[id].add(reason);
      }
    }
    const groupsMap = {};
    const leadById = Object.fromEntries((leads || []).map(l => [l.id, l]));
    for (const l of leads || []) {
      if (!reasonsByLead[l.id]) continue;
      const root = find(l.id);
      groupsMap[root] = groupsMap[root] || [];
      groupsMap[root].push(l.id);
    }
    const groups = Object.values(groupsMap)
      .filter(ids => ids.length >= 2)
      .map(ids => ({
        reasons: Array.from(new Set(ids.flatMap(id => Array.from(reasonsByLead[id] || [])))),
        leads: ids
          .map(id => leadById[id])
          .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || '')),
      }));

    res.json({ success: true, groups });
  } catch (err) {
    log.error(`Pipeline duplicates failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/admin/pipeline/merge — Manually merge a duplicate into a primary.
// Body: { primary_id, duplicate_id }
// Fills the primary's empty fields from the duplicate, concatenates notes,
// repoints child rows (outreach_sequences, conversations, contacts,
// lead_tasks), writes an audit entry, then deletes the duplicate.
// ---------------------------------------------------------------------------
router.post('/pipeline/merge', async (req, res) => {
  try {
    const db = getServiceClient();
    const { primary_id, duplicate_id } = req.body || {};
    if (!primary_id || !duplicate_id || primary_id === duplicate_id) {
      return res.status(400).json({ success: false, error: 'primary_id and duplicate_id (distinct) required' });
    }
    const { data: pair, error: pairErr } = await db
      .from('leads')
      .select('*')
      .eq('tenant_id', FGA_TENANT_ID)
      .in('id', [primary_id, duplicate_id]);
    if (pairErr) throw pairErr;
    const primary = (pair || []).find(l => l.id === primary_id);
    const dup = (pair || []).find(l => l.id === duplicate_id);
    if (!primary || !dup) return res.status(404).json({ success: false, error: 'Lead not found' });

    // Fill empty primary fields from the duplicate (primary always wins)
    const FILL = ['name', 'company_name', 'email', 'phone', 'service_type', 'city', 'hq_state', 'address', 'website', 'domain', 'industry', 'size', 'lead_source', 'priority_tier', 'lead_score'];
    const updates = {};
    for (const f of FILL) {
      if ((primary[f] === null || primary[f] === undefined || primary[f] === '') && dup[f]) updates[f] = dup[f];
    }
    if (dup.notes) {
      updates.notes = primary.notes
        ? `${primary.notes}\n\n— Merged from duplicate (${dup.company_name || dup.name}) —\n${dup.notes}`
        : dup.notes;
    }
    updates.metadata = { ...(dup.metadata || {}), ...(primary.metadata || {}) };

    // Repoint child rows to the primary
    for (const table of ['outreach_sequences', 'conversations', 'contacts', 'lead_tasks']) {
      const { error: rpErr } = await db
        .from(table)
        .update({ lead_id: primary_id })
        .eq('lead_id', duplicate_id)
        .eq('tenant_id', FGA_TENANT_ID);
      if (rpErr) log.warn(`Merge repoint ${table} failed: ${rpErr.message}`);
    }

    const { error: upErr } = await db
      .from('leads')
      .update(updates)
      .eq('id', primary_id)
      .eq('tenant_id', FGA_TENANT_ID);
    if (upErr) throw upErr;

    await logLeadActivity(db, 'lead_merged', primary_id, {
      merged_from: duplicate_id,
      merged_name: dup.company_name || dup.name,
      filled_fields: Object.keys(updates).filter(k => k !== 'metadata'),
    });

    const { error: delErr } = await db
      .from('leads')
      .delete()
      .eq('id', duplicate_id)
      .eq('tenant_id', FGA_TENANT_ID);
    if (delErr) throw delErr;

    log.info(`Pipeline merge: ${duplicate_id} → ${primary_id}`);
    res.json({ success: true, primary_id });
  } catch (err) {
    log.error(`Pipeline merge failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/admin/pipeline/:leadId/tasks — Create a follow-up task
// ---------------------------------------------------------------------------
router.post('/pipeline/:leadId/tasks', async (req, res) => {
  try {
    const db = getServiceClient();
    const { leadId } = req.params;
    const { title, due_at } = req.body || {};
    if (!title || !title.trim()) {
      return res.status(400).json({ success: false, error: 'title required' });
    }
    const { data: task, error } = await db
      .from('lead_tasks')
      .insert({
        tenant_id: FGA_TENANT_ID,
        lead_id: leadId,
        title: title.trim(),
        due_at: due_at || null,
      })
      .select()
      .single();
    if (error) throw error;
    await logLeadActivity(db, 'task_created', leadId, { task_id: task.id, title: task.title, due_at: task.due_at });
    res.json({ success: true, task });
  } catch (err) {
    log.error(`Pipeline task create failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/admin/pipeline/:leadId/activity — Admin audit trail for a lead
// (activity_log rows; the UI merges these with conversations client-side)
// ---------------------------------------------------------------------------
router.get('/pipeline/:leadId/activity', async (req, res) => {
  try {
    const db = getServiceClient();
    const { data: events, error } = await db
      .from('activity_log')
      .select('id, agent, action, level, metadata, created_at')
      .eq('tenant_id', FGA_TENANT_ID)
      .eq('entity_type', 'lead')
      .eq('entity_id', req.params.leadId)
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw error;
    res.json({ success: true, events: events || [] });
  } catch (err) {
    log.error(`Pipeline activity failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// BULK OUTREACH SEND (2026-06-09)
//
// Lets Patrick select multiple draft-ready prospects in the Pipeline
// drill-down and send each prospect's OWN individualized email draft as a
// controlled, throttled batch. Email channel only — Facebook DMs stay
// manual by design (the approve endpoint never auto-sends them).
//
// The per-prospect send is the SAME logic as the individual approve route
// (sendEmailOutreachSequence below is shared by both), so personalization,
// signature refresh, status transitions, conversation updates and lead
// lifecycle advancement are identical whether one email or fifty go out.
//
// Duplicate protection: the helper atomically claims the sequence
// (draft → sending) with a conditional UPDATE, so a double-click, a
// concurrent individual approve, or an overlapping batch can never send
// the same draft twice. On failure the claim reverts to 'draft' so the
// draft stays editable and safely retryable.
//
// Scheduling: there is no backend scheduled-outreach capability for admin
// sends, so this ships Send Now only. Scheduled batches are a documented
// future enhancement — do NOT bolt on a one-off scheduler here.
// ---------------------------------------------------------------------------

// Shared individual email send — extracted to core/outreach-send.js
// (2026-07-03) so the autonomous outreach agent uses the SAME proven path
// (atomic claim, shell, CAN-SPAM unsubscribe, status transitions, drip
// enrollment) as the manual + bulk routes. Do not re-inline or fork it.
const { sendEmailOutreachSequence } = require('../../core/outreach-send');

// In-process batch runner. One batch at a time per process; progress is
// persisted per item so the browser can navigate away and poll later.
const activeOutreachBatches = new Set();
const BULK_SEND_DELAY_MS = 1100; // ~1 send/sec — under Resend's rate limit
// Unified 2026-07-21 (was a private narrow set: won/lost/rejected/
// disqualified — which would have allowed bulk-sending a FIRST touch to a
// lead who had already replied). Now the shared never-cold-contact set.
const { NEVER_COLD_CONTACT: TERMINAL_LEAD_STATUSES } = require('../../core/growth/lead-status');

async function saveBatchItems(db, batchId, items) {
  await db.from('outreach_batches')
    .update({ items, updated_at: new Date().toISOString() })
    .eq('id', batchId)
    .eq('tenant_id', FGA_TENANT_ID);
}

function countBatchItems(items) {
  const counts = { total: items.length, sent: 0, failed: 0, skipped: 0, queued: 0, sending: 0 };
  for (const it of items) counts[it.status] = (counts[it.status] || 0) + 1;
  return counts;
}

async function runOutreachBatch(batchId) {
  if (activeOutreachBatches.has(batchId)) return;
  activeOutreachBatches.add(batchId);
  const db = getServiceClient();
  try {
    const { data: batch } = await db
      .from('outreach_batches')
      .select('*')
      .eq('id', batchId)
      .eq('tenant_id', FGA_TENANT_ID)
      .single();
    if (!batch || batch.status !== 'running') return;

    const items = batch.items || [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.status !== 'queued') continue;

      item.status = 'sending';
      await saveBatchItems(db, batchId, items);

      // Revalidate the lead right before sending — it may have moved to a
      // terminal stage or been merged away since the batch was created.
      const { data: lead } = await db
        .from('leads')
        .select('id, status')
        .eq('id', item.lead_id)
        .eq('tenant_id', FGA_TENANT_ID)
        .single();
      if (!lead) {
        item.status = 'skipped';
        item.error = 'Lead no longer exists';
      } else if (TERMINAL_LEAD_STATUSES.has(lead.status)) {
        item.status = 'skipped';
        item.error = `Lead is ${lead.status} — not contacting`;
      } else {
        const result = await sendEmailOutreachSequence(db, item.lead_id, item.sequence_id, { batchId });
        if (result.ok) {
          item.status = 'sent';
          item.error = null;
        } else if (result.code === 'already_processed') {
          // Someone (or a previous run) already sent this exact draft —
          // never a failure, never a resend.
          item.status = 'skipped';
          item.error = result.error;
        } else {
          item.status = 'failed';
          item.error = result.error;
        }
      }
      await saveBatchItems(db, batchId, items);
      if (i < items.length - 1) {
        await new Promise(r => setTimeout(r, BULK_SEND_DELAY_MS));
      }
    }

    const counts = countBatchItems(items);
    await db.from('outreach_batches')
      .update({ status: 'completed', finished_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', batchId)
      .eq('tenant_id', FGA_TENANT_ID);

    // Batch-level audit entry
    await db.from('activity_log').insert({
      tenant_id: FGA_TENANT_ID,
      agent: 'admin',
      action: 'bulk_outreach_completed',
      entity_type: 'outreach_batch',
      entity_id: batchId,
      level: 'info',
      metadata: { ...counts, channel: 'email', retry_of: batch.retry_of || null },
    });
    log.info(`Bulk outreach batch ${batchId} completed: ${counts.sent} sent, ${counts.failed} failed, ${counts.skipped} skipped`);
  } catch (err) {
    log.error(`Bulk outreach batch ${batchId} crashed: ${err.message}`);
    try {
      await db.from('outreach_batches')
        .update({ status: 'completed', finished_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', batchId)
        .eq('tenant_id', FGA_TENANT_ID);
    } catch { /* best effort */ }
  } finally {
    activeOutreachBatches.delete(batchId);
  }
}

// If the API process restarted mid-batch, a batch can be stuck 'running'
// with no runner. Detect it (stale updated_at + not in the active set),
// fail the unfinished items so Retry Failed can pick them up, and close
// the batch. Called from the GET endpoints so the UI self-heals.
async function reconcileStaleBatch(db, batch) {
  if (!batch || batch.status !== 'running') return batch;
  if (activeOutreachBatches.has(batch.id)) return batch;
  const ageMs = Date.now() - new Date(batch.updated_at || batch.created_at).getTime();
  if (ageMs < 5 * 60 * 1000) return batch;
  const items = (batch.items || []).map(it =>
    (it.status === 'queued' || it.status === 'sending')
      ? { ...it, status: 'failed', error: 'Interrupted — server restarted mid-batch. Safe to retry.' }
      : it
  );
  const { data: updated } = await db.from('outreach_batches')
    .update({ items, status: 'completed', finished_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', batch.id)
    .eq('tenant_id', FGA_TENANT_ID)
    .select()
    .single();
  log.warn(`Bulk outreach batch ${batch.id} was stale-running — reconciled as interrupted`);
  return updated || batch;
}

// ---------------------------------------------------------------------------
// POST /api/admin/pipeline/outreach/bulk-send — Create + start a batch
// Body: { items: [{ lead_id, sequence_id }] } (1–100 items)
// ---------------------------------------------------------------------------
router.post('/pipeline/outreach/bulk-send', async (req, res) => {
  try {
    const db = getServiceClient();
    const raw = Array.isArray(req.body?.items) ? req.body.items : [];
    if (raw.length === 0) return res.status(400).json({ success: false, error: 'items is required' });
    if (raw.length > 100) return res.status(400).json({ success: false, error: 'Max 100 prospects per batch' });

    // Dedupe by sequence_id; validate shape
    const seen = new Set();
    const requested = [];
    for (const it of raw) {
      if (!it || typeof it.lead_id !== 'string' || typeof it.sequence_id !== 'string') {
        return res.status(400).json({ success: false, error: 'Each item needs lead_id and sequence_id' });
      }
      if (seen.has(it.sequence_id)) continue;
      seen.add(it.sequence_id);
      requested.push({ lead_id: it.lead_id, sequence_id: it.sequence_id });
    }

    // One batch at a time — overlapping batches make rate limits and
    // duplicate protection much harder to reason about.
    const { data: running } = await db
      .from('outreach_batches')
      .select('id, updated_at, status, items, created_at, retry_of, started_at, finished_at, channel')
      .eq('tenant_id', FGA_TENANT_ID)
      .eq('status', 'running')
      .order('created_at', { ascending: false })
      .limit(1);
    if (running && running[0]) {
      const reconciled = await reconcileStaleBatch(db, running[0]);
      if (reconciled.status === 'running') {
        return res.status(409).json({ success: false, error: 'A bulk send is already in progress', batch_id: running[0].id });
      }
    }

    // Crash recovery: a sequence stuck in 'sending' for >10 min means a
    // previous process died mid-claim. Release it back to draft.
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await db.from('outreach_sequences')
      .update({ sequence_status: 'draft' })
      .eq('tenant_id', FGA_TENANT_ID)
      .eq('sequence_status', 'sending')
      .lt('updated_at', tenMinAgo);

    // Server-side pre-validation — mirror of the individual approve rules.
    const leadIds = [...new Set(requested.map(r => r.lead_id))];
    const seqIds = requested.map(r => r.sequence_id);
    const [{ data: leadsRows }, { data: seqRows }] = await Promise.all([
      db.from('leads').select('id, company_name, name, status, email').eq('tenant_id', FGA_TENANT_ID).in('id', leadIds),
      db.from('outreach_sequences').select('id, lead_id, sequence_status, sequence_type').eq('tenant_id', FGA_TENANT_ID).in('id', seqIds),
    ]);
    const leadMap = Object.fromEntries((leadsRows || []).map(l => [l.id, l]));
    const seqMap = Object.fromEntries((seqRows || []).map(s => [s.id, s]));

    const items = requested.map(r => {
      const lead = leadMap[r.lead_id];
      const seq = seqMap[r.sequence_id];
      const base = {
        lead_id: r.lead_id,
        sequence_id: r.sequence_id,
        company: lead ? (lead.company_name || lead.name || 'Unknown') : 'Unknown',
        status: 'queued',
        error: null,
      };
      if (!lead) return { ...base, status: 'skipped', error: 'Lead not found' };
      if (!seq) return { ...base, status: 'skipped', error: 'Draft not found' };
      if (seq.lead_id !== r.lead_id) return { ...base, status: 'skipped', error: 'Draft does not belong to this prospect' };
      if (seq.sequence_type !== 'email') return { ...base, status: 'skipped', error: 'Facebook DMs are sent manually' };
      if (seq.sequence_status !== 'draft') return { ...base, status: 'skipped', error: `Draft is already ${seq.sequence_status}` };
      if (TERMINAL_LEAD_STATUSES.has(lead.status)) return { ...base, status: 'skipped', error: `Lead is ${lead.status}` };
      return base;
    });

    if (!items.some(it => it.status === 'queued')) {
      return res.status(400).json({ success: false, error: 'No sendable drafts in selection', items });
    }

    const { data: batch, error } = await db
      .from('outreach_batches')
      .insert({
        tenant_id: FGA_TENANT_ID,
        status: 'running',
        channel: 'email',
        created_by: req.user?.email || 'admin',
        items,
      })
      .select()
      .single();
    if (error) throw error;

    setImmediate(() => runOutreachBatch(batch.id));
    log.info(`Bulk outreach batch ${batch.id} started: ${items.filter(i => i.status === 'queued').length} queued`);
    res.json({ success: true, batch });
  } catch (err) {
    log.error(`Bulk outreach create failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/admin/pipeline/outreach/batches — Recent batches (reopen progress)
// ---------------------------------------------------------------------------
router.get('/pipeline/outreach/batches', async (req, res) => {
  try {
    const db = getServiceClient();
    const { data: batches, error } = await db
      .from('outreach_batches')
      .select('*')
      .eq('tenant_id', FGA_TENANT_ID)
      .order('created_at', { ascending: false })
      .limit(5);
    if (error) throw error;
    const reconciled = [];
    for (const b of (batches || [])) reconciled.push(await reconcileStaleBatch(db, b));
    res.json({ success: true, batches: reconciled });
  } catch (err) {
    log.error(`Bulk outreach list failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/admin/pipeline/outreach/batches/:batchId — Progress polling
// ---------------------------------------------------------------------------
router.get('/pipeline/outreach/batches/:batchId', async (req, res) => {
  try {
    const db = getServiceClient();
    const { data: batch, error } = await db
      .from('outreach_batches')
      .select('*')
      .eq('id', req.params.batchId)
      .eq('tenant_id', FGA_TENANT_ID)
      .single();
    if (error || !batch) return res.status(404).json({ success: false, error: 'Batch not found' });
    const reconciled = await reconcileStaleBatch(db, batch);
    res.json({ success: true, batch: reconciled });
  } catch (err) {
    log.error(`Bulk outreach status failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/admin/pipeline/outreach/batches/:batchId/retry — Retry failures
// Creates a NEW batch containing ONLY the failed items of a completed batch.
// Sent and skipped items are structurally excluded — they can't be resent.
// ---------------------------------------------------------------------------
router.post('/pipeline/outreach/batches/:batchId/retry', async (req, res) => {
  try {
    const db = getServiceClient();
    const { data: source, error } = await db
      .from('outreach_batches')
      .select('*')
      .eq('id', req.params.batchId)
      .eq('tenant_id', FGA_TENANT_ID)
      .single();
    if (error || !source) return res.status(404).json({ success: false, error: 'Batch not found' });
    if (source.status !== 'completed') {
      return res.status(400).json({ success: false, error: 'Batch is still running' });
    }
    const failed = (source.items || []).filter(it => it.status === 'failed');
    if (failed.length === 0) {
      return res.status(400).json({ success: false, error: 'No failed items to retry' });
    }
    const { data: running } = await db
      .from('outreach_batches')
      .select('id, status, updated_at, created_at, items')
      .eq('tenant_id', FGA_TENANT_ID)
      .eq('status', 'running')
      .limit(1);
    if (running && running[0]) {
      const reconciled = await reconcileStaleBatch(db, running[0]);
      if (reconciled.status === 'running') {
        return res.status(409).json({ success: false, error: 'A bulk send is already in progress', batch_id: running[0].id });
      }
    }
    const { data: batch, error: insErr } = await db
      .from('outreach_batches')
      .insert({
        tenant_id: FGA_TENANT_ID,
        status: 'running',
        channel: source.channel || 'email',
        created_by: req.user?.email || 'admin',
        retry_of: source.id,
        items: failed.map(it => ({ ...it, status: 'queued', error: null })),
      })
      .select()
      .single();
    if (insErr) throw insErr;
    setImmediate(() => runOutreachBatch(batch.id));
    log.info(`Bulk outreach retry batch ${batch.id} started (${failed.length} items, retry of ${source.id})`);
    res.json({ success: true, batch });
  } catch (err) {
    log.error(`Bulk outreach retry failed: ${err.message}`);
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

    // Audit trail (2026-06-09): snapshot the current values so the
    // activity log records exactly what changed (from → to).
    const { data: before } = await db
      .from('leads')
      .select(Object.keys(updates).join(','))
      .eq('id', leadId)
      .eq('tenant_id', FGA_TENANT_ID)
      .single();

    const { data: lead, error } = await db
      .from('leads')
      .update(updates)
      .eq('id', leadId)
      .eq('tenant_id', FGA_TENANT_ID)
      .select()
      .single();

    if (error) throw error;

    const changes = {};
    for (const key of Object.keys(updates)) {
      const from = before ? before[key] : undefined;
      if (from !== updates[key]) changes[key] = { from: from ?? null, to: updates[key] };
    }
    if (Object.keys(changes).length > 0) {
      const action = changes.status ? 'stage_changed' : 'lead_updated';
      await logLeadActivity(db, action, leadId, { changes });
    }

    res.json({ success: true, lead });
  } catch (err) {
    log.error(`Admin pipeline update failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/admin/pipeline/:leadId/fb-dm/mark-sent
//
// Patrick clicks "Open + Copy" on an fb_only lead's DM draft. The frontend
// copies the message to clipboard, opens m.me/<page>, and calls this
// endpoint to flip the conversation's draft_status → 'sent' + sent_at = now().
// That single flip is what makes the LeadDetail timeline include the row
// (LeadDetail.tsx suppresses outbound rows where draft_status is set but
// not 'sent') and what bumps the LeadCard badge from "✓ Draft ready" → "📨 Sent".
//
// Body: { conversation_id?: string }  — optional; defaults to most recent
//                                         outbound facebook_dm for this lead.
// ---------------------------------------------------------------------------
router.post('/pipeline/:leadId/fb-dm/mark-sent', async (req, res) => {
  try {
    const db = getServiceClient();
    const { leadId } = req.params;
    const conversationId = req.body?.conversation_id;

    // Find the FB DM conversation to flip. If caller supplied an id,
    // use it; otherwise grab the most recent outbound facebook_dm.
    let query = db
      .from('conversations')
      .select('id, metadata')
      .eq('lead_id', leadId)
      .eq('tenant_id', FGA_TENANT_ID)
      .eq('channel', 'facebook_dm')
      .eq('direction', 'outbound')
      .order('created_at', { ascending: false })
      .limit(1);
    if (conversationId) {
      query = db
        .from('conversations')
        .select('id, metadata')
        .eq('id', conversationId)
        .eq('tenant_id', FGA_TENANT_ID);
    }
    const { data: convs, error: findErr } = await query;
    if (findErr) throw findErr;
    if (!convs || convs.length === 0) {
      return res.status(404).json({ success: false, error: 'FB DM conversation not found for this lead' });
    }
    const conv = convs[0];

    // Sent state lives in metadata.draft_status — the conversations table has
    // no status/sent_at/updated_at columns.
    const newMetadata = {
      ...(conv.metadata || {}),
      draft_status: 'sent',
      sent_via: 'manual',
      sent_by: 'admin',
      sent_at: new Date().toISOString(),
    };
    const { error: upErr } = await db
      .from('conversations')
      .update({ metadata: newMetadata })
      .eq('id', conv.id)
      .eq('tenant_id', FGA_TENANT_ID); // isolation guard 2026-07-22
    if (upErr) throw upErr;

    log.info(`FB DM marked sent (manual): lead=${leadId} conv=${conv.id}`);
    res.json({ success: true, conversation_id: conv.id });
  } catch (err) {
    log.error(`fb-dm mark-sent failed: ${err.message}`);
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

    // 2026-06-09: a lead can now have multiple drafts at once (one per
    // channel — email primary, FB DM as manual backup). Fetch the latest
    // of EACH sequence_type so the detail page can render every active
    // channel. The legacy `sequence` field stays in the response for the
    // mobile app, which still reads a single sequence — pick email if
    // present so the auto-sendable channel is what the mobile approval
    // queue sees.
    const { data: allSeqs, error: seqErr } = await db
      .from('outreach_sequences')
      .select('id, sequence_status, sequence_type, message_subject, message_body, created_at, contact_id')
      .eq('lead_id', leadId)
      .eq('tenant_id', FGA_TENANT_ID)
      .order('created_at', { ascending: false });
    if (seqErr) throw seqErr;

    // Dedupe by sequence_type, keep the most recent of each channel.
    const seenTypes = new Set();
    const sequences = [];
    for (const s of (allSeqs || [])) {
      if (seenTypes.has(s.sequence_type)) continue;
      seenTypes.add(s.sequence_type);
      sequences.push(s);
    }
    const sequence =
      sequences.find((s) => s.sequence_type === 'email') ||
      sequences[0] ||
      null;

    // Return ALL conversations for this lead (SMS, email, DM — any direction)
    // so the timeline shows the full history.
    const { data: conversations } = await db
      .from('conversations')
      .select('id, channel, direction, message_subject, message_body, metadata, created_at')
      .eq('tenant_id', FGA_TENANT_ID)
      .eq('lead_id', leadId)
      .order('created_at', { ascending: false });

    res.json({ success: true, sequence, sequences, conversations: conversations || [] });
  } catch (err) {
    log.error(`Admin outreach fetch failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/admin/pipeline/:leadId/outreach/generate — "Create Draft Now"
//
// Manual trigger for a single-lead outreach draft. It does NOT draft inline —
// it enqueues a single-lead job for the EXISTING outreach agent (the same
// mechanism the reject/regenerate route uses), so there is exactly one
// drafting implementation and all safety/guardrails/usage caps still apply.
//
// Duplicate protection (matches the "prevent duplicate draft generation"
// requirement):
//   1. Refuses if an actionable draft (draft/sending) already exists.
//   2. No-ops (returns already_queued) if an outreach job is already
//      pending/processing for this lead.
// The outreach agent only drafts leads at 'enriched'/'scored' (and 'fb_only'
// under fb_fallback mode), so a lead still awaiting enrichment is rejected
// with a clear message rather than silently enqueuing a job that no-ops.
// ---------------------------------------------------------------------------
router.post('/pipeline/:leadId/outreach/generate', async (req, res) => {
  try {
    const db = getServiceClient();
    const { leadId } = req.params;

    const { data: lead, error: leadErr } = await db
      .from('leads')
      .select('id, lifecycle_stage, enrichment_status')
      .eq('id', leadId)
      .eq('tenant_id', FGA_TENANT_ID)
      .single();
    if (leadErr) throw leadErr;
    if (!lead) return res.status(404).json({ success: false, error: 'Lead not found' });

    // Dedup 1 — an actionable draft already exists for this lead.
    const { data: existing } = await db
      .from('outreach_sequences')
      .select('id')
      .eq('tenant_id', FGA_TENANT_ID)
      .eq('lead_id', leadId)
      .in('sequence_status', ['draft', 'sending']);
    if (existing && existing.length) {
      return res.status(409).json({ success: false, error: 'A draft already exists for this lead.' });
    }

    // Dedup 2 — an outreach job is already queued/running for this lead.
    const { data: pendingJobs } = await db
      .from('agent_jobs')
      .select('id, payload, status')
      .eq('tenant_id', FGA_TENANT_ID)
      .eq('agent_name', 'outreach')
      .in('status', ['pending', 'processing']);
    const dupJob = (pendingJobs || []).find((j) => j.payload && j.payload.lead_id === leadId);
    if (dupJob) {
      return res.json({
        success: true,
        already_queued: true,
        job_id: dupJob.id,
        message: 'Draft generation is already in progress for this lead.',
      });
    }

    // The outreach agent only drafts these lifecycle stages.
    const draftable = ['enriched', 'scored', 'fb_only'];
    if (!draftable.includes(lead.lifecycle_stage)) {
      return res.status(400).json({
        success: false,
        error: `This lead isn't ready for a draft yet (stage: ${lead.lifecycle_stage || 'unknown'}). It needs enrichment to find a contact channel first.`,
      });
    }

    // fb_only leads only get a (manual) FB DM draft in fb_fallback mode.
    const payload = { lead_id: leadId };
    if (lead.lifecycle_stage === 'fb_only') payload.mode = 'fb_fallback';

    const { data: job, error: jobErr } = await db.from('agent_jobs').insert({
      tenant_id: FGA_TENANT_ID,
      agent_name: 'outreach',
      payload,
      status: 'pending',
    }).select('id').single();
    if (jobErr) throw jobErr;

    await logLeadActivity(db, 'outreach_draft_requested', leadId, { job_id: job.id, manual: true });
    res.json({
      success: true,
      job_id: job.id,
      message: 'Draft requested — the Outreach Agent will generate it in a moment.',
    });
  } catch (err) {
    log.error(`Manual outreach generate failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/admin/pipeline/:leadId/reply — the owner sends a reply to a
// prospect who wrote back (2026-07-21, Patrick-approved).
//
// This is the ONLY send path for suggested replies, and it is human-clicked
// by construction: adminMiddleware (Patrick), explicit body text (he can edit
// the AI suggestion or write his own), one prospect at a time. Suppression is
// still honored — an unsubscribed/bounced address cannot be replied to from
// here even manually. Sends from the outreach identity so it lands in the
// same thread context; reply-to stays patrick@ for the Gmail sync.
// ---------------------------------------------------------------------------
router.post('/pipeline/:leadId/reply', async (req, res) => {
  try {
    const db = getServiceClient();
    const leadId = req.params.leadId;
    const subject = String(req.body?.subject || '').trim();
    const body = String(req.body?.body || '').trim();
    if (!subject || !body) {
      return res.status(400).json({ success: false, error: 'subject and body are required' });
    }
    if (body.length > 5000) {
      return res.status(400).json({ success: false, error: 'body too long' });
    }

    const { data: lead, error: leadErr } = await db.from('leads')
      .select('id, name, email, company_name, status, metadata')
      .eq('id', leadId).eq('tenant_id', FGA_TENANT_ID).maybeSingle();
    if (leadErr) throw leadErr;
    if (!lead) return res.status(404).json({ success: false, error: 'Lead not found' });
    if (!lead.email) return res.status(400).json({ success: false, error: 'Lead has no email address' });

    const { isSuppressed } = require('../../core/growth/suppression');
    const sup = await isSuppressed(db, FGA_TENANT_ID, { email: lead.email, leadId: lead.id, channel: 'email' });
    if (sup.suppressed) {
      return res.status(409).json({
        success: false,
        error: `This address is suppressed (${sup.reason || 'unsubscribed/bounced'}) — reply by another channel.`,
      });
    }

    const tenant = await resolveTenant(db, FGA_TENANT_ID);
    const from = tenant?.config?.autosend_from_email || undefined;
    const { sendEmail } = require('../../integrations/email');
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#111827;white-space:pre-wrap;">${esc(body)}</div>`;
    const sendResult = await sendEmail(lead.email, subject, html, {
      from,
      replyTo: 'patrick@firstgenautomate.com',
      text: body,
    });

    const sentAt = new Date().toISOString();
    await db.from('conversations').insert({
      tenant_id: FGA_TENANT_ID,
      lead_id: lead.id,
      channel: 'email',
      direction: 'outbound',
      message_subject: subject,
      message_body: body,
      metadata: { source: 'owner_reply', provider_id: sendResult?.id || null, sent_at: sentAt },
    }).then(() => {}, () => {});

    // Clear the consumed suggestion, resolve the open sales attention items,
    // and give the lead a breathing-room due date (ball is in their court,
    // but the conversation still belongs to the owner).
    const { suggested_reply: _consumed, ...restMeta } = lead.metadata || {};
    await db.from('leads').update({
      metadata: restMeta,
      next_action_due_at: new Date(Date.now() + 3 * 86400_000).toISOString(),
    }).eq('id', lead.id).eq('tenant_id', FGA_TENANT_ID);

    await db.from('attention_queue')
      .update({ resolved_at: sentAt, resolved_by_label: 'owner_reply', resolution: 'accepted' })
      .eq('tenant_id', FGA_TENANT_ID).eq('entity_id', lead.id)
      .like('type', 'sales_reply_%').is('resolved_at', null)
      .then(() => {}, () => {});

    await db.from('activity_log').insert({
      tenant_id: FGA_TENANT_ID,
      agent: 'admin',
      action: 'owner_reply_sent',
      entity_type: 'lead',
      entity_id: lead.id,
      level: 'info',
      metadata: { subject, recipient: lead.email, provider_id: sendResult?.id || null, sent_at: sentAt },
    }).then(() => {}, () => {});

    log.info(`Owner reply sent to ${lead.email} (lead ${lead.id})`);
    res.json({ success: true, sent_to: lead.email, provider_id: sendResult?.id || null });
  } catch (err) {
    log.error(`Owner reply failed: ${err.message}`);
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

    // EMAIL channel — delegate to the shared send helper (same code path the
    // bulk sender uses, including the atomic draft→sending claim that
    // prevents duplicate sends).
    if (sequence.sequence_type === 'email') {
      const result = await sendEmailOutreachSequence(db, leadId, sequence_id);
      if (!result.ok) {
        const statusByCode = {
          not_found: 404,
          mismatch: 400,
          wrong_channel: 400,
          already_processed: 400,
          no_email: 400,
          send_failed: 500,
        };
        return res
          .status(statusByCode[result.code] || 500)
          .json({ success: false, error: result.error });
      }
      return res.json({ success: true, channel: 'email', send_result: result.send_result });
    }

    // NON-EMAIL channels (facebook_dm) — approve only, no auto-send.
    const { error: seqUpdErr } = await db.from('outreach_sequences')
      .update({ sequence_status: 'approved' })
      .eq('id', sequence_id)
      .eq('tenant_id', FGA_TENANT_ID);
    if (seqUpdErr) {
      log.error(`Sequence ${sequence_id} approve status update failed: ${seqUpdErr.message}`);
    }

    // Update conversation metadata
    await db.from('conversations')
      .update({
        metadata: {
          draft_status: 'approved',
          sent_at: new Date().toISOString(),
          send_result: null,
        },
      })
      .eq('tenant_id', FGA_TENANT_ID)
      .eq('sequence_id', sequence_id);

    // Advance lead lifecycle so it doesn't re-draft
    await db.from('leads')
      .update({ lifecycle_stage: 'sequenced', status: 'contacted' })
      .eq('id', leadId)
      .eq('tenant_id', FGA_TENANT_ID);

    res.json({ success: true, channel: sequence.sequence_type, send_result: null });
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
        .eq('tenant_id', FGA_TENANT_ID) // isolation guard 2026-07-22
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
          .eq('id', convRows[0].id)
          .eq('tenant_id', FGA_TENANT_ID); // isolation guard 2026-07-22
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
      .select('id, name, slug, vertical, status, created_at, owner_email');

    if (tenantErr) throw tenantErr;

    const tenantIds = (tenants || []).map(t => t.id);

    const [tierRes, nameRes, billingRes, leadsRes, contentRes, modsRes] = await Promise.all([
      db.from('tenant_config').select('tenant_id, value').eq('key', 'tier').in('tenant_id', tenantIds),
      db.from('tenant_config').select('tenant_id, value').eq('key', 'business_name').in('tenant_id', tenantIds),
      db.from('tenant_config').select('tenant_id, key, value').in('key', ['monthly_rate', 'billing_cadence', 'annual_amount', 'next_renewal', 'is_complimentary', 'setup_fee', 'setup_fee_paid', 'owner_name', 'owner_email', 'phone', 'co_owner_name', 'co_owner_email', 'co_owner_phone', 'subscription_status', 'billing_active', 'first_charged_at', 'churned_at', 'trial_ends_at']).in('tenant_id', tenantIds),
      db.from('leads').select('tenant_id, created_at').in('tenant_id', tenantIds),
      db.from('content_drafts').select('tenant_id, created_at').in('tenant_id', tenantIds),
      db.from('tenant_modules').select('tenant_id, module, enabled').in('tenant_id', tenantIds)
    ]);

    const billingFor = (id, key) => (billingRes.data || []).find(c => c.tenant_id === id && c.key === key)?.value;

    const clients = (tenants || []).map(tenant => {
      const tierCfg = (tierRes.data || []).find(c => c.tenant_id === tenant.id);
      const nameCfg = (nameRes.data || []).find(c => c.tenant_id === tenant.id);
      const tierVal = tierCfg?.value || 'growth';
      const rateRaw = billingFor(tenant.id, 'monthly_rate');
      const monthlyRate = rateRaw !== undefined && rateRaw !== null && rateRaw !== ''
        ? Number(rateRaw)
        : (tierVal === 'scale' ? 399 : tierVal === 'complimentary' ? 0 : 249);
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
        // Thresholds unified with dashboard-summary (2026-07-22): this page
        // used yellow<=30 while the dashboard used yellow<=21, so the same
        // client could be "At Risk" on one screen and fine on the other.
        if (daysSince <= 7) health = 'green';
        else if (daysSince <= 21) health = 'yellow';
      }

      return {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        vertical: tenant.vertical,
        status: tenant.status,
        tier: tierVal,
        business_name: nameCfg?.value || tenant.name,
        monthly_rate: monthlyRate,
        billing_cadence: billingFor(tenant.id, 'billing_cadence') || 'monthly',
        annual_amount: billingFor(tenant.id, 'annual_amount') !== undefined ? Number(billingFor(tenant.id, 'annual_amount')) : undefined,
        next_renewal: billingFor(tenant.id, 'next_renewal') || undefined,
        is_complimentary: billingFor(tenant.id, 'is_complimentary') === 'true',
        setup_fee: billingFor(tenant.id, 'setup_fee') !== undefined ? Number(billingFor(tenant.id, 'setup_fee')) : 199,
        setup_fee_paid: billingFor(tenant.id, 'setup_fee_paid') === 'true',
        // Billing axis (independent of delivery status). A tenant can be
        // billing_active while status is still 'onboarding' (customer delayed).
        subscription_status: billingFor(tenant.id, 'subscription_status') || null,
        first_charged_at: billingFor(tenant.id, 'first_charged_at') || null,
        billing_active: isBillingActive({
          isComplimentary: billingFor(tenant.id, 'is_complimentary') === 'true',
          monthlyRate: monthlyRate,
          churnedAt: billingFor(tenant.id, 'churned_at') || null,
          subscriptionStatus: billingFor(tenant.id, 'subscription_status') || null,
          billingActiveFlag: billingFor(tenant.id, 'billing_active') === 'true',
          trialEndsAt: billingFor(tenant.id, 'trial_ends_at') || null,
          status: tenant.status,
        }),
        owner_email: tenant.owner_email || billingFor(tenant.id, 'owner_email') || '',
        owner_name: billingFor(tenant.id, 'owner_name') || '',
        phone: billingFor(tenant.id, 'phone') || '',
        co_owner_name: billingFor(tenant.id, 'co_owner_name') || '',
        co_owner_email: billingFor(tenant.id, 'co_owner_email') || '',
        co_owner_phone: billingFor(tenant.id, 'co_owner_phone') || '',
        modules: (modsRes.data || []).filter(m => m.tenant_id === tenant.id).map(m => ({ name: m.module, enabled: !!m.enabled })),
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
    const { tier, status, business_name, vertical, monthly_rate, setup_fee, setup_fee_paid, modules, is_complimentary, billing_cadence, annual_amount, next_renewal, owner_email, owner_name, phone, co_owner_name, co_owner_email, co_owner_phone } = req.body;

    // Update tenant-level fields (status, vertical, owner_email) if provided
    const tenantUpdates = {};
    if (status) tenantUpdates.status = status;
    if (vertical) tenantUpdates.vertical = vertical;
    if (owner_email !== undefined && owner_email !== '') tenantUpdates.owner_email = String(owner_email).trim().toLowerCase();

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
    // Contact info — owner_email mirrored into config; owner_name + phone stored in config
    if (owner_email !== undefined && owner_email !== '') configUpdates.push({ tenant_id: tenantId, key: 'owner_email', value: String(owner_email).trim().toLowerCase() });
    if (owner_name !== undefined) configUpdates.push({ tenant_id: tenantId, key: 'owner_name', value: owner_name });
    if (phone !== undefined) configUpdates.push({ tenant_id: tenantId, key: 'phone', value: phone });
    // Optional second owner — recorded on the account (login stays with primary owner).
    if (co_owner_name !== undefined) configUpdates.push({ tenant_id: tenantId, key: 'co_owner_name', value: co_owner_name });
    if (co_owner_email !== undefined) configUpdates.push({ tenant_id: tenantId, key: 'co_owner_email', value: String(co_owner_email).trim().toLowerCase() });
    if (co_owner_phone !== undefined) configUpdates.push({ tenant_id: tenantId, key: 'co_owner_phone', value: co_owner_phone });
    if (monthly_rate !== undefined) configUpdates.push({ tenant_id: tenantId, key: 'monthly_rate', value: monthly_rate });
    // Billing cadence ('monthly' | 'annual'). Annual stores annual_amount +
    // next_renewal; monthly_rate is sent normalized (annual/12) so MRR stays right.
    if (billing_cadence !== undefined) configUpdates.push({ tenant_id: tenantId, key: 'billing_cadence', value: billing_cadence === 'annual' ? 'annual' : 'monthly' });
    if (annual_amount !== undefined) configUpdates.push({ tenant_id: tenantId, key: 'annual_amount', value: String(annual_amount) });
    if (next_renewal !== undefined) configUpdates.push({ tenant_id: tenantId, key: 'next_renewal', value: next_renewal });
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

    // Update module toggles if provided. Accepts [{ name, enabled }] (preferred)
    // or legacy bare strings (treated as enabled). Update-or-insert so toggling
    // a module the tenant doesn't have a row for yet still persists.
    if (modules && Array.isArray(modules)) {
      for (const mod of modules) {
        const name = typeof mod === 'string' ? mod : (mod.name || mod.module);
        const enabled = typeof mod === 'string' ? true : !!mod.enabled;
        if (!name) continue;
        const { data: updated, error: updErr } = await db
          .from('tenant_modules')
          .update({ enabled })
          .eq('tenant_id', tenantId)
          .eq('module', name)
          .select('module');
        if (updErr) { log.error(`Module update failed for ${name}: ${updErr.message}`); continue; }
        if (!updated || updated.length === 0) {
          const { error: insErr } = await db
            .from('tenant_modules')
            .insert({ tenant_id: tenantId, module: name, enabled });
          if (insErr) log.error(`Module insert failed for ${name}: ${insErr.message}`);
        }
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
// ---------------------------------------------------------------------------
// GET /api/admin/web-chats — Inbox for orphan web-chat conversations
//
// The AI Chat Agent on the marketing site captures inbound questions from
// anonymous visitors who haven't (yet) given enough info to spin up a lead
// row. Those messages land in conversations with lead_id=NULL and become
// invisible to the lead-centric pipeline. This endpoint surfaces them so
// Patrick has a single inbox view to tune the chat agent and spot
// qualified leads it missed.
//
// Query params:
//   limit — default 100, max 500
//   days  — default 30, restricts to created_at >= now - days
//   include_lead_attached — if 'true', also returns inbound rows that
//                           DO have a lead_id (full inbox view).
//                           Default false (orphans only).
// ---------------------------------------------------------------------------
router.get('/web-chats', async (req, res) => {
  try {
    const db = getServiceClient();
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const days = Math.min(Number(req.query.days) || 30, 365);
    const includeAttached = String(req.query.include_lead_attached || 'false') === 'true';
    const sinceIso = new Date(Date.now() - days * 86400000).toISOString();

    // Tenant scope (2026-07-22, Command Center purpose directive): FGA-only
    // by default — this inbox is Patrick's own website chats. The ONLY other
    // mode is an EXPLICIT single-tenant drilldown (`?tenant=<uuid>`, linked
    // from the Information Center with the tenant name pinned in the UI).
    // There is no "all tenants" mode: a cross-tenant message-body surface is
    // exactly the bleed this directive forbids. Missing/ambiguous tenant
    // never falls back to all — the default is FGA, full stop.
    const tenantParam = String(req.query.tenant || '').trim();
    const scopeTenantId = tenantParam && tenantParam !== 'all' ? tenantParam : FGA_TENANT_ID;
    let q = db.from('conversations')
      .select('id, tenant_id, lead_id, channel, direction, message_body, metadata, created_at')
      .eq('tenant_id', scopeTenantId)
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

    // Resolve tenant names for the label chip (cheap: distinct ids only).
    const chatTenantIds = [...new Set((rows || []).map((r) => r.tenant_id))];
    const { data: chatTenants } = chatTenantIds.length
      ? await db.from('tenants').select('id, name').in('id', chatTenantIds)
      : { data: [] };
    const tenantNameById = {};
    for (const t of chatTenants || []) tenantNameById[t.id] = t.name;

    // Cluster by visitor session if metadata.session_id is present so
    // a single conversational thread renders as one inbox card instead
    // of one row per message. Fallback: group consecutive messages
    // within 10 minutes of each other.
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
          tenant_id: row.tenant_id,
          tenant_name: tenantNameById[row.tenant_id] || null,
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
      // messages came in DESC order — first_at is the EARLIEST so update
      // it as we walk
      if (row.created_at < sess.first_at) sess.first_at = row.created_at;
      if (row.created_at > sess.last_at) sess.last_at = row.created_at;
    }
    // Reverse messages within each session to chronological order
    for (const s of sessions) {
      s.messages.reverse();
    }

    res.json({ success: true, sessions, total_messages: (rows || []).length });
  } catch (err) {
    log.error(`Admin web-chats failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// TEXTS INBOX — two-way SMS. Reads the `conversations` ledger (channel='sms')
// and groups by the peer phone number into threads. Inbound is logged by the
// Telnyx webhook; outbound by the AI responders + POST /texts/reply below.
// ---------------------------------------------------------------------------
function _peerOf(row) {
  const md = row.metadata || {};
  return (row.direction === 'inbound' ? md.from : md.to) || md.from || md.to
    || (row.lead_id ? `lead:${row.lead_id}` : row.contact_id ? `contact:${row.contact_id}` : 'unknown');
}

// Cold-prospecting outbound (e.g. the facebook-prospecting agent) is NOT a
// two-way conversation the owner manages — it must never appear in the Texts
// inbox. These rows stay in `conversations` for the lead timeline; we just hide
// them here. (Cold SMS is disabled anyway as of 2026-06-18, but historical rows
// and any future outreach-channel logging are filtered defensively.) A genuine
// inbound reply from such a person still threads under their phone number and
// DOES show — only the outbound prospecting touch is suppressed.
const TEXTS_HIDDEN_AGENTS = new Set(['facebook-prospecting']);
function _isOutreachRow(row) {
  return !!(row.metadata && TEXTS_HIDDEN_AGENTS.has(row.metadata.agent));
}

// Manually-archived threads: tenant_config 'texts_archived' = { "<phone>": isoTs }.
// A thread is archived if (a) it was manually archived and has had no newer
// message since, or (b) it's gone quiet past the auto-archive window.
async function _readTextsArchived(db) {
  try {
    const { data } = await db.from('tenant_config').select('value')
      .eq('tenant_id', FGA_TENANT_ID).eq('key', 'texts_archived').maybeSingle();
    let v = data && data.value;
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } }
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  } catch { return {}; }
}
async function _writeTextsArchived(db, map) {
  await db.from('tenant_config').upsert(
    { tenant_id: FGA_TENANT_ID, key: 'texts_archived', value: map },
    { onConflict: 'tenant_id,key' },
  );
}

// GET /api/admin/texts — thread list (latest message per peer).
router.get('/texts', async (req, res) => {
  try {
    const db = getServiceClient();
    const days = Math.min(Number(req.query.days) || 60, 365);
    const sinceIso = new Date(Date.now() - days * 86400000).toISOString();
    const { data: rows, error } = await db.from('conversations')
      .select('id, lead_id, contact_id, direction, message_body, metadata, created_at')
      .eq('tenant_id', FGA_TENANT_ID).eq('channel', 'sms')
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: false })
      .limit(3000);
    if (error) throw error;

    const threads = new Map();
    for (const r of (rows || [])) {
      if (_isOutreachRow(r)) continue; // cold prospecting — not a two-way thread
      const peer = _peerOf(r);
      if (!threads.has(peer)) {
        threads.set(peer, {
          phone: peer, lead_id: r.lead_id || null, contact_id: r.contact_id || null,
          last_at: r.created_at, last_body: r.message_body, last_direction: r.direction, count: 0,
        });
      }
      const th = threads.get(peer);
      th.count++;
      if (r.direction === 'inbound') th.has_inbound = true;
      if (r.lead_id && !th.lead_id) th.lead_id = r.lead_id;
      if (r.contact_id && !th.contact_id) th.contact_id = r.contact_id;
    }

    // Legacy / sender-less inbound texts that were only logged to `messages`
    // (before every inbound SMS was mirrored to conversations) surface under a
    // single read-only "Unknown sender" thread so older texts aren't lost.
    const convExtIds = new Set((rows || []).map((r) => r.metadata && r.metadata.external_id).filter(Boolean));
    const { data: legacyMsgs } = await db.from('messages')
      .select('id, direction, body, external_id, created_at, sent_at')
      .eq('tenant_id', FGA_TENANT_ID).eq('channel', 'sms')
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: false }).limit(800);
    const orphans = (legacyMsgs || []).filter((m) => !m.external_id || !convExtIds.has(m.external_id));
    if (orphans.length) {
      const latest = orphans[0];
      const existing = threads.get('unknown');
      if (existing) { existing.count += orphans.length; }
      else {
        threads.set('unknown', {
          phone: 'unknown', lead_id: null, contact_id: null,
          last_at: latest.created_at || latest.sent_at, last_body: latest.body,
          last_direction: latest.direction, count: orphans.length,
        });
      }
    }

    let list = Array.from(threads.values());
    const leadIds = [...new Set(list.map((t) => t.lead_id).filter(Boolean))];
    const leadMap = {};
    if (leadIds.length) {
      const { data: leads } = await db.from('leads').select('id, name, company_name, lead_source').eq('tenant_id', FGA_TENANT_ID).in('id', leadIds); // isolation guard 2026-07-22
      for (const l of (leads || [])) leadMap[l.id] = l;
    }
    for (const t of list) {
      const l = t.lead_id && leadMap[t.lead_id];
      t.name = l ? (l.name || l.company_name || null) : null;
    }

    // Two-way inbox only: hide cold OUTBOUND-ONLY prospecting threads. A thread
    // to a prospecting-sourced lead with no inbound reply is cold outreach, not
    // a conversation the owner manages — drop it. The moment that person texts
    // back (has_inbound), it's a real thread and reappears. Follow-ups to real
    // customers / manual contacts (non-prospecting leads) always show.
    list = list.filter((t) => {
      if (t.has_inbound) return true;
      const l = t.lead_id && leadMap[t.lead_id];
      return !(l && l.lead_source === 'prospecting_agent');
    });

    // Active vs Archived split — keeps the inbox short. A thread auto-archives
    // after `archive_days` (default 14) of silence; manual archive hides it
    // sooner; a newer message un-archives it automatically. Nothing is deleted.
    const archivedMap = await _readTextsArchived(db);
    const archiveDays = Math.min(Math.max(Number(req.query.archive_days) || 14, 1), 365);
    const cutoff = Date.now() - archiveDays * 86400000;
    const isArchived = (t) => {
      const at = archivedMap[t.phone];
      if (at) return new Date(t.last_at).getTime() <= new Date(at).getTime();
      return new Date(t.last_at).getTime() < cutoff;
    };
    const activeList = list.filter((t) => !isArchived(t));
    const archivedList = list.filter(isArchived);
    const view = String(req.query.view) === 'archived' ? 'archived' : 'active';
    const shown = (view === 'archived' ? archivedList : activeList).sort((a, b) => (a.last_at < b.last_at ? 1 : -1));
    res.json({ success: true, view, threads: shown, active_count: activeList.length, archived_count: archivedList.length, archive_days: archiveDays });
  } catch (err) {
    log.error(`Admin texts failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/admin/texts/archive { phone } — hide a thread from Active now.
router.post('/texts/archive', async (req, res) => {
  try {
    const phone = String((req.body && req.body.phone) || '').trim();
    if (!phone) return res.status(400).json({ success: false, error: 'phone required' });
    const db = getServiceClient();
    const map = await _readTextsArchived(db);
    map[phone] = new Date().toISOString();
    await _writeTextsArchived(db, map);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// POST /api/admin/texts/unarchive { phone } — move a thread back to Active.
router.post('/texts/unarchive', async (req, res) => {
  try {
    const phone = String((req.body && req.body.phone) || '').trim();
    if (!phone) return res.status(400).json({ success: false, error: 'phone required' });
    const db = getServiceClient();
    const map = await _readTextsArchived(db);
    delete map[phone];
    await _writeTextsArchived(db, map);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// GET /api/admin/texts/thread?phone= — full thread for a peer.
router.get('/texts/thread', async (req, res) => {
  try {
    const db = getServiceClient();
    const phone = String(req.query.phone || '').trim();
    if (!phone) return res.status(400).json({ success: false, error: 'phone required' });
    const { data: rows, error } = await db.from('conversations')
      .select('id, direction, message_body, metadata, created_at, lead_id, contact_id, ai_classification')
      .eq('tenant_id', FGA_TENANT_ID).eq('channel', 'sms')
      .order('created_at', { ascending: true }).limit(1000);
    if (error) throw error;
    const convRows = (rows || []).filter((r) => !_isOutreachRow(r));
    let messages = convRows.filter((r) => _peerOf(r) === phone).map((r) => ({
      id: r.id, direction: r.direction, body: r.message_body, at: r.created_at,
      classification: r.ai_classification || null,
      agent: (r.metadata && r.metadata.agent) || null,
    }));
    // The "Unknown sender" thread also includes legacy messages-only texts.
    if (phone === 'unknown') {
      const convExtIds = new Set(convRows.map((r) => r.metadata && r.metadata.external_id).filter(Boolean));
      const { data: legacyMsgs } = await db.from('messages')
        .select('id, direction, body, external_id, created_at, sent_at')
        .eq('tenant_id', FGA_TENANT_ID).eq('channel', 'sms')
        .order('created_at', { ascending: true }).limit(1000);
      const extra = (legacyMsgs || [])
        .filter((m) => !m.external_id || !convExtIds.has(m.external_id))
        .map((m) => ({ id: m.id, direction: m.direction, body: m.body, at: m.created_at || m.sent_at, classification: null, agent: null }));
      messages = messages.concat(extra).sort((a, b) => (a.at < b.at ? -1 : 1));
    }
    res.json({ success: true, phone, messages });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/admin/texts/reply { to, body } — owner sends an SMS reply.
router.post('/texts/reply', async (req, res) => {
  try {
    const { to, body } = req.body || {};
    const text = String(body || '').trim();
    if (!to || !text) return res.status(400).json({ success: false, error: 'to and body required' });
    if (/^(lead|contact|unknown):/.test(String(to))) {
      return res.status(400).json({ success: false, error: 'No phone number on file for this thread — open the lead to message them.' });
    }
    const db = getServiceClient();
    const { resolveTenant } = require('../../core/tenant');
    const tenant = await resolveTenant(db, FGA_TENANT_ID);
    const { sendSms } = require('../../integrations/telnyx');
    let smsResult;
    try {
      smsResult = await sendSms(tenant.integrations, to, text, {
        tenant, tenantSlug: tenant.slug, agentName: 'owner-reply', isAutomated: false,
      });
    } catch (e) {
      return res.status(502).json({ success: false, error: `Send failed: ${e.message}` });
    }
    const sentAt = new Date().toISOString();
    try { await db.from('messages').insert({ tenant_id: FGA_TENANT_ID, channel: 'sms', direction: 'outbound', body: text, external_id: smsResult.sid, status: 'sent', sent_at: sentAt }); } catch (_) { /* legacy */ }
    try { await db.from('conversations').insert({ tenant_id: FGA_TENANT_ID, channel: 'sms', direction: 'outbound', message_body: text, metadata: { external_id: smsResult.sid, to, agent: 'owner-manual' } }); } catch (_) { /* non-fatal */ }
    res.json({ success: true, sid: smsResult.sid });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

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
      pilotsAwaitingRes,
      blockedCampaignsRes,
    ] = await Promise.all([
      // Outreach EMAIL drafts awaiting review — FGA tenant only. (The old
      // query filtered a nonexistent `status` column and always errored to
      // 0.) Same definition as /dashboard-summary: email drafts on leads
      // still in the new_lead stage.
      countNewLeadEmailDrafts(db),

      // Content drafts pending approval (any tenant — FGA approves its own).
      db.from('content_drafts')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', FGA_TENANT_ID)
        .eq('status', 'pending'),

      // Inbound replies that need Patrick's attention. Excludes orphan
      // web_chat sessions (lead_id IS NULL) — those have their own
      // surface at /admin/web-chats and are not pipeline replies. Last
      // 7 days, anchored to a lead.
      db.from('conversations')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', FGA_TENANT_ID)
        .eq('direction', 'inbound')
        .not('lead_id', 'is', null)
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

      // Targeted campaigns: pilot batches done, waiting on owner approval.
      db.from('targeted_campaigns')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', FGA_TENANT_ID)
        .eq('status', 'pilot_awaiting_approval'),

      // Targeted campaigns halted by a budget/API cap (NOT FB DM queue —
      // FB DMs are a manual backup, never an attention item).
      db.from('targeted_campaigns')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', FGA_TENANT_ID)
        .in('status', ['budget_limit_reached', 'api_limit_reached']),
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
      targeted_pilots_awaiting: pilotsAwaitingRes.count || 0,
      targeted_campaigns_blocked: blockedCampaignsRes.count || 0,
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
// POST /api/admin/clients/:tenantId/onboarding-step — manual check/uncheck
// ---------------------------------------------------------------------------
// Onboarding steps are normally auto-derived from real data, but some are
// done out-of-band (e.g. branding set up manually, number ported in) and the
// auto-detection misses them. This lets Patrick force a step done (or undo
// that) from the tracker. Overrides live in tenant_config.onboarding_manual_steps
// as a JSON map { stepKey: true }. Forcing a step that auto-detection already
// reports as done is a harmless no-op (the OR in the status route wins either
// way); unchecking only clears the manual override — it can never hide a step
// that is genuinely complete in the data.
const ONBOARDING_STEP_KEYS = new Set([
  'tenant_created', 'welcome_sent', 'wizard_complete', 'branding', 'phone_number',
  'app_icon', 'content_batch', 'modules_enabled', 'founder_call', 'apple_review', 'go_live',
]);
router.post('/clients/:tenantId/onboarding-step', async (req, res) => {
  try {
    const db = getServiceClient();
    const { tenantId } = req.params;
    const stepKey = req.body?.step_key;
    const done = req.body?.done === true || req.body?.done === 'true';
    if (!stepKey || !ONBOARDING_STEP_KEYS.has(stepKey)) {
      return res.status(400).json({ success: false, error: 'Valid step_key is required' });
    }

    const { data: row } = await db
      .from('tenant_config')
      .select('value')
      .eq('tenant_id', tenantId)
      .eq('key', 'onboarding_manual_steps')
      .maybeSingle();
    let overrides = {};
    try { overrides = row?.value ? JSON.parse(row.value) : {}; } catch { overrides = {}; }
    if (typeof overrides !== 'object' || overrides === null) overrides = {};

    if (done) overrides[stepKey] = true;
    else delete overrides[stepKey];

    const { error } = await db
      .from('tenant_config')
      .upsert(
        { tenant_id: tenantId, key: 'onboarding_manual_steps', value: JSON.stringify(overrides) },
        { onConflict: 'tenant_id,key' }
      );
    if (error) throw error;
    res.json({ success: true, overrides });
  } catch (err) {
    log.error(`onboarding-step override failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// The 7-day workflow: read it, and clear the steps a human owes.
// ---------------------------------------------------------------------------
//
// WHY THESE EXIST (2026-08-02)
// The workflow has steps only a person can clear — `founder_video_call` on day
// 5 and `client_photo_upload` on day 6 — plus anything parked at 'waiting' on
// a founder task like connecting the client's socials in Buffer. Nothing in
// the API could mark any of them done, so a real onboarding would have run
// perfectly for four days and then deadlocked on day 5 with no way forward
// short of hand-writing SQL.
//
// `/onboarding/status` below is a separate heuristic view derived from
// tenant_config. These read the actual workflow.

/** GET /api/admin/onboarding/workflow/:tenantId — the real step-by-step state. */
/** Plain names for the wizard steps, for the picker. */
const WIZARD_STEP_LABELS = Object.freeze({
  welcome: 'Welcome screen',
  business_basics: 'Business basics',
  path_choice: 'App delivery choice',
  apple_details: 'Apple developer details',
  logo: 'Logo upload',
  colors: 'Brand colours',
  photos: 'Photo seed (20+ job photos)',
  voice: 'Brand voice (3 sentences)',
  services: 'Services and hours',
  voice_receptionist: 'Voice receptionist setup',
  gbp: 'Google review link',
  social: 'Facebook and Instagram',
  customers: 'Existing customer list',
  dfy_website: 'Website preferences',
  ai_chat: 'Chat agent training',
  agreement: 'Service agreement',
  complete: 'Finish screen',
});

router.get('/onboarding/workflow/:tenantId', async (req, res) => {
  try {
    const db = getServiceClient();
    const onboarding = require('../../core/onboarding');
    const { warningsFor, EMAIL_STEPS, ACTION_DESCRIPTIONS } = require('../../core/onboarding-center');

    const status = await onboarding.getOnboardingStatus(db, req.params.tenantId);
    if (!status) {
      return res.json({ success: true, workflow: null, message: 'No active onboarding workflow' });
    }

    // The Center shows EVERY step, not just what is blocking — it is a
    // checklist he works through, not a queue that hands him one thing.
    const { data: allSteps, error: stepsErr } = await db
      .from('onboarding_steps').select('*')
      .eq('workflow_id', status.workflowId)
      .order('day', { ascending: true }).order('created_at', { ascending: true });
    if (stepsErr) throw stepsErr;

    const { config, modules } = await onboarding.loadCenterContext(db, req.params.tenantId);

    const steps = (allSteps || []).map((s) => ({
      id: s.id,
      step: s.step_name,
      description: ACTION_DESCRIPTIONS[s.step_name] || s.description || s.step_name,
      day: s.day,
      dayLabel: onboarding.dayLabel(s.day),
      status: s.status,
      owedBy: s.kind,
      isEmail: Boolean(EMAIL_STEPS[s.step_name]),
      reason: s.last_error || null,
      completedAt: s.completed_at || null,
      // Advisory only — the Center shows these and lets him proceed.
      warnings: warningsFor(s.step_name, { config, modules }),
    }));

    // What the customer has given us, and what is still outstanding. The
    // wizard collects most of it, so this is how he knows whether to chase.
    const intakeFields = [
      ['logo_url', 'Logo'],
      ['color_primary', 'Brand colours'],
      ['brand_voice', 'Brand voice'],
      ['key_services', 'Services'],
      ['business_hours', 'Hours'],
      ['google_review_url', 'Google review link'],
      ['customers', 'Customer list'],
      ['facebook_url', 'Facebook'],
      ['instagram_url', 'Instagram'],
    ];
    const filled = (v) => v !== undefined && v !== null && v !== ''
      && !(Array.isArray(v) && v.length === 0);

    res.json({
      success: true,
      workflow: {
        id: status.workflowId,
        progress: `${status.completedCount}/${status.totalSteps}`,
        counts: {
          completed: status.completedCount,
          pending: status.pendingCount,
          waiting: status.waitingCount,
          failed: status.failedCount,
          blocked: status.blockedCount,
        },
        steps,
        intake: intakeFields.map(([key, label]) => ({
          key, label, filled: filled(config[key]),
        })),
        modules: [...modules],
      },
    });
  } catch (err) {
    log.error(`onboarding workflow read failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Which wizard steps the customer gets asked.
 *
 * Patrick fills what he can in the Onboarding Center; the wizard collects the
 * rest. Anything he already has should not be asked for again — being asked
 * twice for something you already handed over reads as nobody paying
 * attention.
 *
 * A step is dropped when he switches it off here, OR when every field it
 * collects is already filled in. `agreement` can never be dropped: it is the
 * customer's acceptance of the service terms, and consent cannot be given on
 * their behalf from an admin panel.
 */
router.get('/onboarding/wizard-steps/:tenantId', async (req, res) => {
  try {
    const db = getServiceClient();
    const resolver = require('../../core/onboarding-step-resolver');
    const { loadCenterContext } = require('../../core/onboarding');
    const { config, modules } = await loadCenterContext(db, req.params.tenantId);

    const excluded = Array.isArray(config.wizard_excluded_steps) ? config.wizard_excluded_steps : [];
    const shown = new Set(resolver.resolveApplicableSteps([...modules], config.delivery_path || null, { excluded, config }));
    const relevant = new Set(resolver.resolveApplicableSteps([...modules], config.delivery_path || null));

    const hasValue = (v) => v !== undefined && v !== null && v !== ''
      && !(Array.isArray(v) && v.length === 0);

    const steps = resolver.STEP_DEFINITIONS.map((d) => {
      const fields = resolver.STEP_FIELDS[d.key] || [];
      const filled = fields.length > 0 && fields.every((f) => hasValue(config[f]));
      return {
        key: d.key,
        label: WIZARD_STEP_LABELS[d.key] || d.key,
        skippable: !resolver.NON_SKIPPABLE.includes(d.key),
        // Relevant to this tenant at all (their modules / delivery path).
        relevant: relevant.has(d.key),
        excluded: excluded.includes(d.key),
        alreadyFilled: filled,
        askedFor: shown.has(d.key),
        collects: fields,
      };
    });

    res.json({ success: true, steps });
  } catch (err) {
    log.error(`wizard-steps read failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

/** POST /api/admin/onboarding/wizard-steps/:tenantId — { excluded: [keys] } */
router.post('/onboarding/wizard-steps/:tenantId', async (req, res) => {
  try {
    const resolver = require('../../core/onboarding-step-resolver');
    const wanted = Array.isArray(req.body?.excluded) ? req.body.excluded : [];

    const unknown = wanted.filter((k) => !resolver.STEP_DEFINITIONS.some((d) => d.key === k));
    if (unknown.length) {
      return res.status(400).json({ success: false, error: `Unknown wizard step(s): ${unknown.join(', ')}` });
    }
    const forbidden = wanted.filter((k) => resolver.NON_SKIPPABLE.includes(k));
    if (forbidden.length) {
      // Refuse rather than silently drop it, so nobody believes the agreement
      // step was switched off when it was not.
      return res.status(400).json({
        success: false,
        error: `These cannot be switched off: ${forbidden.join(', ')}. `
          + `The agreement is the customer's own acceptance of the terms.`,
      });
    }

    const { error } = await getServiceClient().from('tenant_config').upsert(
      { tenant_id: req.params.tenantId, key: 'wizard_excluded_steps', value: wanted },
      { onConflict: 'tenant_id,key' },
    );
    if (error) throw error;

    log.info(`Wizard steps switched off for ${req.params.tenantId}: ${wanted.join(', ') || '(none)'}`);
    res.json({ success: true, excluded: wanted });
  } catch (err) {
    log.error(`wizard-steps write failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

/** POST /api/admin/onboarding/step/:stepId/complete — mark a human step done. */
router.post('/onboarding/step/:stepId/complete', async (req, res) => {
  try {
    const { tenant_id } = req.body || {};
    if (!tenant_id) return res.status(400).json({ success: false, error: 'tenant_id is required' });
    const { completeStep } = require('../../core/onboarding');
    const step = await completeStep(getServiceClient(), tenant_id, req.params.stepId);
    log.info(`Admin completed onboarding step ${step.step_name} for ${tenant_id}`);
    res.json({ success: true, step: step.step_name, status: step.status });
  } catch (err) {
    log.error(`complete step failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

/** POST /api/admin/onboarding/step/:stepId/skip — this one does not apply. */
router.post('/onboarding/step/:stepId/skip', async (req, res) => {
  try {
    const { tenant_id, reason } = req.body || {};
    if (!tenant_id) return res.status(400).json({ success: false, error: 'tenant_id is required' });
    if (!reason) {
      // A skip with no reason is indistinguishable later from a step that was
      // silently dropped, which is the whole failure mode this engine exists
      // to avoid.
      return res.status(400).json({ success: false, error: 'reason is required to skip a step' });
    }
    const { skipStep } = require('../../core/onboarding');
    const step = await skipStep(getServiceClient(), tenant_id, req.params.stepId, reason);
    log.info(`Admin skipped onboarding step ${step.step_name} for ${tenant_id}: ${reason}`);
    res.json({ success: true, step: step.step_name, status: step.status });
  } catch (err) {
    log.error(`skip step failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/admin/onboarding/step/:stepId/preview — what this step WOULD do.
 *
 * Sends nothing and changes nothing. For an email it returns the rendered
 * subject and body with the customer's details filled in, ready to read and
 * edit; for an action, a sentence describing it. Warnings come back alongside
 * rather than as a refusal — Patrick decides.
 */
router.get('/onboarding/step/:stepId/preview', async (req, res) => {
  try {
    const db = getServiceClient();
    const { data: step, error } = await db
      .from('onboarding_steps').select('*').eq('id', req.params.stepId).maybeSingle();
    if (error) throw error;
    if (!step) return res.status(404).json({ success: false, error: 'No such step' });

    const { previewStep } = require('../../core/onboarding-center');
    const { loadCenterContext } = require('../../core/onboarding');
    const preview = await previewStep(db, step.tenant_id, step, loadCenterContext);
    res.json({ success: true, step: step.step_name, preview });
  } catch (err) {
    log.error(`step preview failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/admin/onboarding/step/:stepId/run — do it, now.
 *
 * The ONLY path that sends anything. Body may carry an edited `subject` and
 * `html` for email steps. Nothing in this system reaches a customer without a
 * call to this route.
 */
router.post('/onboarding/step/:stepId/run', async (req, res) => {
  try {
    const db = getServiceClient();
    const { data: step, error } = await db
      .from('onboarding_steps').select('*').eq('id', req.params.stepId).maybeSingle();
    if (error) throw error;
    if (!step) return res.status(404).json({ success: false, error: 'No such step' });

    const { runStep } = require('../../core/onboarding-center');
    const onboarding = require('../../core/onboarding');
    const result = await runStep(db, step.tenant_id, step, {
      subject: req.body?.subject,
      html: req.body?.html,
      force: req.body?.force === true,
    }, {
      ctxLoader: onboarding.loadCenterContext,
      executeHandler: onboarding._internals._executeStepHandler,
      NotImplementedStep: onboarding.NotImplementedStep,
      WaitingOnPerson: onboarding.WaitingOnPerson,
      AlreadySettled: onboarding.AlreadySettled,
    });

    log.info(`Onboarding step ${step.step_name} run by admin -> ${result.status}`);
    // A step that ended 'waiting' or 'failed' is information, not a server
    // error — the Center shows the reason and the button stays available.
    res.json({ success: true, step: step.step_name, ...result });
  } catch (err) {
    log.error(`step run failed: ${err.message}`);
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

      // Manual overrides — steps Patrick force-checked from the tracker when
      // auto-detection can't see the work (set via /clients/:id/onboarding-step).
      let manualSteps = {};
      try { manualSteps = config.onboarding_manual_steps ? JSON.parse(config.onboarding_manual_steps) : {}; } catch { manualSteps = {}; }
      if (typeof manualSteps !== 'object' || manualSteps === null) manualSteps = {};

      // Derive real step completion from actual data, then OR in any manual
      // override so a force-checked step shows done even if undetectable.
      const rawSteps = [
        { day: 0, key: 'tenant_created', label: 'Tenant created', auto: true },
        { day: 0, key: 'welcome_sent', label: 'Welcome email + magic link sent', auto: !!config.welcome_email_sent_at },
        // Reads `onboarding_stage`, which the wizard actually writes
        // (api/routes/tenant.js sets it to 'in_app_intake_complete' on the
        // final step). The previous condition looked at
        // `onboarding_state_complete` and `wizard_status` — two keys that
        // appear nowhere else in the codebase and are never written by
        // anything, so this box could never tick no matter what the customer
        // did.
        { day: 1, key: 'wizard_complete', label: 'Customer completed intake wizard', auto: config.onboarding_stage === 'in_app_intake_complete' || !!config.onboarding_intake_completed_at },
        { day: 1, key: 'branding', label: 'Branding configured (logo, colors)', auto: !!config.logo_url || !!config.brand_primary_color },
        {
          day: 2,
          key: 'phone_number',
          label: 'Telnyx phone number provisioned',
          auto: !!config.telnyx_phone_number,
        },
        { day: 2, key: 'app_icon', label: 'Branded app icon generated', auto: !!config.app_icon_url },
        { day: 3, key: 'content_batch', label: 'Initial content batch generated', auto: draftCount > 0 },
        { day: 4, key: 'modules_enabled', label: 'Modules enabled per plan', auto: Object.values(modules).some(v => v) },
        { day: 5, key: 'founder_call', label: 'Day-5 founder onboarding call', auto: !!config.founder_call_completed_at },
        { day: 6, key: 'apple_review', label: 'Apple App Store review', auto: t.status === 'active' || !!config.app_store_live_at },
        { day: 7, key: 'go_live', label: 'GO LIVE — tenant status active', auto: t.status === 'active' },
      ];
      const steps = rawSteps.map(s => {
        const manual = !s.auto && manualSteps[s.key] === true;
        return { day: s.day, key: s.key, label: s.label, done: s.auto || manual, manual };
      });

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

    // Get all tenants (not just active, so we can show paused/churned too).
    // is_demo is needed so demo tenants never count toward MRR/setup totals.
    const { data: allTenants, error: tenantErr } = await db
      .from('tenants')
      .select('id, name, status, is_demo');

    if (tenantErr) throw tenantErr;

    const tenantIds = (allTenants || []).map(t => t.id);

    // Fetch all relevant config keys in one query
    const { data: configs, error: configErr } = await db
      .from('tenant_config')
      .select('tenant_id, key, value')
      .in('key', ['tier', 'monthly_rate', 'setup_fee', 'setup_fee_paid', 'business_name', 'is_complimentary', 'monthly_cost',
        'billing_active', 'subscription_status', 'trial_ends_at', 'churned_at'])
      .in('tenant_id', tenantIds);

    if (configErr) throw configErr;

    // Build per-tenant config map
    const configMap = {};
    for (const c of (configs || [])) {
      if (!configMap[c.tenant_id]) configMap[c.tenant_id] = {};
      configMap[c.tenant_id][c.key] = c.value;
    }

    // Per-tenant cost-to-serve comes ONLY from the explicit
    // tenant_config.monthly_cost key. finance_entries expense rows under a
    // customer's tenant_id are that customer's OWN business books (e.g.
    // A Kut Above's imported $2.2M ledger), NOT FGA's cost of serving them
    // — summing those here produced wildly wrong margins.

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
      // Per-tenant monthly cost: explicit config or $0 (no guessing)
      const monthlyCost = readNumericConfig(cfg.monthly_cost, null);
      const estimatedMonthlyCost = monthlyCost !== null ? monthlyCost : 0;

      // Billing-aware classification (core/revenue.js): MRR keys off
      // isBillingActive, NOT the operational status — a tenant can be
      // onboarding (delivery) while already billing (923A).
      const classification = classifyTenant(tenant, (k) => cfg[k], FGA_TENANT_ID);

      const clientEntry = {
        id: tenant.id,
        name: cfg.business_name || tenant.name,
        status: tenant.status,
        is_demo: !!tenant.is_demo,
        tier,
        monthly_rate: monthlyRate,
        custom_rate: customRate !== null,
        setup_fee: setupFee,
        setup_fee_paid: setupFeePaid,
        is_complimentary: isComplimentary,
        monthly_cost: estimatedMonthlyCost,
        margin: monthlyRate - estimatedMonthlyCost,
        billing_active: classification.billing_active,
        client_type: classification.type,
      };

      clients.push(clientEntry);

      // Demo tenants are sales sandboxes — never revenue. Skip ALL money
      // aggregates (MRR, costs, setup fees) but keep them in the client
      // list (flagged is_demo) so the portal can still show them.
      if (tenant.is_demo) continue;
      if (tenant.id === FGA_TENANT_ID) continue; // internal — never client revenue

      // MRR counts billing-active, non-complimentary tenants (billing axis,
      // not delivery axis).
      if (classification.billing_active) {
        mrr += monthlyRate;
        byTier[tier] = (byTier[tier] || 0) + 1;
        totalMonthlyCost += estimatedMonthlyCost;
      } else if (isComplimentary && tenant.status === 'active') {
        mrrComplimentary += monthlyRate;
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
      // Platform subscription revenue is written by the Stripe webhook
      // under the PAYING CUSTOMER's tenant_id with category='subscription'
      // (see integrations/finance-sync.js) — so the category filter, not a
      // tenant filter, is the discriminator here. Demo tenants are excluded
      // so seeded sandbox data can never appear as platform revenue.
      const demoIds = new Set((allTenants || []).filter(t => t.is_demo).map(t => t.id));
      const { data: historyData, error: histErr } = await db
        .from('finance_entries')
        .select('date, amount, tenant_id')
        .eq('entry_type', 'income')
        .eq('category', 'subscription')
        .order('date', { ascending: true });

      if (!histErr && historyData) {
        const monthlyMap = {};
        for (const entry of historyData) {
          if (demoIds.has(entry.tenant_id)) continue;
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
      .select('tenant_id, metadata, created_at')
      .eq('agent', 'onboarding_wizard')
      .eq('action', 'step_completed')
      .order('created_at', { ascending: true });

    if (evErr) throw evErr;

    // Group by tenant — build per-tenant timeline
    const byTenant = {};
    for (const e of (events || [])) {
      const tid = e.tenant_id;
      if (!byTenant[tid]) byTenant[tid] = {};
      const step = e.metadata?.step;
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
 *
 * SENDS NOTHING. Provisioning stages the tenant and its checklist; every
 * customer-facing send — including the welcome with their login link —
 * happens from the Onboarding Center, previewed, on a click.
 *
 * Returns: { success, tenant_id, slug, modules_enabled, staged_only }
 */
// Module keys come from core/module-registry.js — the single source of truth.
// This route used to carry its own copy of the list and to insert whatever the
// client sent, unvalidated. That is how live tenant 923A ended up with an
// `ai_voice_receptionist` row: a key no gate in the system matches, enabled
// forever, doing nothing. `assertValidModules` now rejects unknown keys at the
// write boundary so a typo can never reach `tenant_modules` again.
const {
  assertValidModules,
  findMissingDependencies,
  defaultModulesForTier,
  keysForProducts,
  BASE_KEYS,
} = require('../../core/module-registry');

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

    const tier = ['growth', 'scale', 'complimentary', 'custom'].includes(body.tier)
      ? body.tier : 'growth';
    const isComplimentary = !!body.is_complimentary || tier === 'complimentary';

    // Billing cadence — 'monthly' (default) or 'annual'. Annual clients are
    // invoiced once a year but we normalize monthly_rate = annual/12 so MRR +
    // revenue trends stay comparable across monthly and annual clients.
    const billingCadence = body.billing_cadence === 'annual' ? 'annual' : 'monthly';
    const TIER_MONTHLY = { growth: 249, scale: 399, complimentary: 0 };
    const tierMonthly = TIER_MONTHLY[tier] !== undefined ? TIER_MONTHLY[tier] : TIER_MONTHLY.growth;
    let monthlyRate;
    if (isComplimentary) {
      monthlyRate = 0;
    } else if (body.monthly_rate !== undefined && body.monthly_rate !== null && body.monthly_rate !== '') {
      monthlyRate = Number(body.monthly_rate) || 0;
    } else if (billingCadence === 'annual' && body.annual_amount) {
      monthlyRate = Math.round((Number(body.annual_amount) || 0) / 12);
    } else {
      monthlyRate = tierMonthly;
    }
    const annualAmount = billingCadence === 'annual'
      ? (body.annual_amount ? Number(body.annual_amount) : Math.round(monthlyRate * 12))
      : null;
    const nextRenewal = billingCadence === 'annual'
      ? (body.next_renewal || new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10))
      : null;

    const phone = body.phone ? String(body.phone).trim() : null;
    const vertical = body.vertical ? String(body.vertical).trim() : 'home_services';
    const notes = body.notes ? String(body.notes).trim() : '';
    // Optional second owner — recorded on the account for reference only.
    // The portal login still goes to the primary owner email above.
    const coOwnerName = body.co_owner_name ? String(body.co_owner_name).trim() : '';
    const coOwnerEmail = body.co_owner_email ? String(body.co_owner_email).trim().toLowerCase() : '';
    const coOwnerPhone = body.co_owner_phone ? String(body.co_owner_phone).trim() : '';
    // Optional one-time setup fee (recorded only; charged via Stripe separately).
    const setupFee = (body.setup_fee !== undefined && body.setup_fee !== null && body.setup_fee !== '')
      ? Number(body.setup_fee) : null;
    // body.send_welcome is deliberately IGNORED. It used to default true and
    // fire sendWelcomeWizard from this route — a send with no preview and no
    // click on the step itself. The Center's welcome step is the only sender.

    // What Patrick picked. Two accepted shapes:
    //   products: ['content_approval', ...]  — the admin form. One product can
    //             map to several module keys (scheduling needs approval_queue
    //             AND publishing), so this is the shape that cannot go wrong.
    //   modules:  ['approval_queue', ...]    — raw keys, for the runbook curl.
    // Both are validated. An unknown value is a 400, not a silently inert row
    // that displays as enabled and never runs.
    const effectiveTier = (tier === 'scale' || isComplimentary) ? 'scale' : 'growth';
    let modules;
    try {
      if (Array.isArray(body.products) && body.products.length) {
        modules = keysForProducts(body.products);
      } else if (Array.isArray(body.modules) && body.modules.length) {
        modules = assertValidModules([...BASE_KEYS, ...body.modules]);
      } else {
        modules = defaultModulesForTier(effectiveTier);
      }
    } catch (moduleErr) {
      return res.status(400).json({ success: false, error: moduleErr.message });
    }

    // Advisory, not blocking: a module that needs another one to do anything
    // (content_engine without publishing generates posts that never go out).
    // Reported back so the picker can show it rather than discovering it weeks
    // later as "why has nothing posted".
    const moduleWarnings = findMissingDependencies(modules).map(
      (w) => `${w.label} needs ${w.missing.join(' + ')} to do anything`,
    );

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
      // Not a warning. A tenant whose modules failed to insert is a tenant
      // that will quietly do nothing — better to fail the call than to hand
      // back success and let someone find out in a week.
      if (modErr) throw new Error(`Failed to enable modules: ${modErr.message}`);
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
    if (coOwnerName) configRows.push({ tenant_id: tenant.id, key: 'co_owner_name', value: coOwnerName });
    if (coOwnerEmail) configRows.push({ tenant_id: tenant.id, key: 'co_owner_email', value: coOwnerEmail });
    if (coOwnerPhone) configRows.push({ tenant_id: tenant.id, key: 'co_owner_phone', value: coOwnerPhone });
    if (setupFee !== null && !Number.isNaN(setupFee)) configRows.push({ tenant_id: tenant.id, key: 'setup_fee', value: String(setupFee) });

    // Billing cadence + normalized rate (skip rate for complimentary)
    configRows.push({ tenant_id: tenant.id, key: 'billing_cadence', value: billingCadence });
    if (!isComplimentary) {
      configRows.push({ tenant_id: tenant.id, key: 'monthly_rate', value: String(monthlyRate) });
    }
    if (billingCadence === 'annual' && !isComplimentary) {
      configRows.push({ tenant_id: tenant.id, key: 'annual_amount', value: String(annualAmount) });
      if (nextRenewal) configRows.push({ tenant_id: tenant.id, key: 'next_renewal', value: nextRenewal });
    }

    // The config rows are what every later step reads — owner_email is the
    // recipient of every send, the billing keys gate the money steps. A failed
    // write here silently produced a tenant whose steps would all refuse (or
    // worse, whose billing guards had nothing to check), so it is checked like
    // the tenant insert is.
    const { error: cfgErr } = await db.from('tenant_config')
      .upsert(configRows, { onConflict: 'tenant_id,key' });
    if (cfgErr) {
      throw new Error(
        `tenant created but its configuration could not be written: ${cfgErr.message}. `
        + 'Fix the cause and onboard again with a different slug, or repair the config by hand.',
      );
    }

    // NOTHING IS SENT FROM HERE. Deliberately.
    //
    // This used to call sendWelcomeWizard — email plus potentially SMS — with
    // a checkbox that defaulted on. So "Onboard this client" SENT, before the
    // Onboarding Center's welcome step was ever previewed or clicked, and the
    // rule that nothing reaches a customer without a click was false at the
    // very first screen of the flow.
    //
    // Provisioning stages; the Center sends. The welcome step there calls
    // core/welcome-wizard.sendWelcomeFromCenter, which does everything the
    // old path did (auth user, membership, fresh magic link, email, SMS) at
    // the moment Patrick clicks Send — with the preview in front of him.

    // Start the 7-day workflow.
    //
    // This call did not exist until 2026-07-30, which is why
    // `onboarding_workflows` had zero rows in production — ever, for any
    // tenant, including the ones that were successfully onboarded by hand. The
    // engine was written, scheduled, and never once reachable from the flow
    // that creates tenants.
    //
    // `modules` is passed through so the workflow only seeds steps for what
    // this client actually bought. `welcomeAlreadySent` stops the day-0 step
    // from sending a second welcome email on top of the magic-link one the
    // wizard just sent.
    let workflow_id = null;
    let workflow_error = null;
    try {
      const { startOnboarding } = require('../../core/onboarding');
      const wf = await startOnboarding(db, tenant.id, {
        owner_name: ownerName,
        business_name: businessName,
        email,
        tier,
        vertical,
        modules,
        // Nothing was sent during provisioning, so the workflow keeps its
        // welcome step — that step IS how the welcome goes out now.
        welcomeAlreadySent: false,
        // The billing shape decides which money steps exist at all: none for
        // complimentary, no monthly subscription for annual, and the custom
        // setup fee (including an explicit $0) controls the invoice step.
        is_complimentary: isComplimentary,
        billing_cadence: billingCadence,
        setup_fee: (setupFee !== null && !Number.isNaN(setupFee)) ? setupFee : undefined,
        provisioned_via: 'admin_manual',
      });
      workflow_id = wf?.id || null;
    } catch (wfErr) {
      // The tenant exists and the owner can log in; that part succeeded and
      // must not be rolled back. But the caller has to know the timeline did
      // not start, because nothing else will tell them.
      workflow_error = wfErr.message;
      log.error(`startOnboarding failed for tenant ${tenant.id}: ${wfErr.message}`);
    }

    log.info(
      `Admin staged tenant ${tenant.id} (${businessName} <${email}>) — ` +
      `tier=${tier}, modules=${modules.length}, complimentary=${isComplimentary}, ` +
      `workflow=${workflow_id || 'FAILED'} — nothing sent`,
    );

    res.json({
      success: true,
      tenant_id: tenant.id,
      slug: tenant.slug,
      modules_enabled: modules.length,
      module_keys: modules,
      module_warnings: moduleWarnings,
      // Nothing sends from provisioning. The Center's welcome step is the
      // send, and the UI directs Patrick there.
      staged_only: true,
      workflow_id,
      workflow_error,
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

    // Attach tenant name + message count + preview. Demo tenants (Apex
    // Plumbing seed data) are excluded — their threads are demo fixtures,
    // not real customer requests. Threads with no tenant (direct emails to
    // support@) always show.
    const allTenantIds = (data || []).map(t => t.tenant_id).filter(Boolean);
    const tenantsRes = allTenantIds.length
      ? await db.from('tenants').select('id, name, is_demo').in('id', allTenantIds)
      : { data: [] };
    const tenantNameById = {};
    const demoTenantIds = new Set();
    for (const t of (tenantsRes.data || [])) {
      tenantNameById[t.id] = t.name;
      if (t.is_demo) demoTenantIds.add(t.id);
    }
    const realThreads = (data || []).filter(t => !t.tenant_id || !demoTenantIds.has(t.tenant_id));

    const threadIds = realThreads.map(t => t.id);
    const countsRes = threadIds.length
      ? await db.from('support_messages').select('thread_id, body').in('thread_id', threadIds).order('created_at', { ascending: false })
      : { data: [] };
    const previewByThread = {};
    const countByThread = {};
    for (const m of (countsRes.data || [])) {
      countByThread[m.thread_id] = (countByThread[m.thread_id] || 0) + 1;
      if (!previewByThread[m.thread_id] && m.body) {
        previewByThread[m.thread_id] = m.body.slice(0, 140);
      }
    }
    const threads = realThreads.map(t => ({
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
    const { format_id, custom_prompt, topic, platform, media_kind, media_urls } = req.body || {};
    const payload = { platform: platform || 'instagram' };
    // format_id is OPTIONAL — when omitted ("Let FGA choose"), the strategy
    // engine selects the format that best serves the idea (planner-enabled
    // tenants) or the agent falls back to its rotation. Only validate when set.
    if (format_id != null && Number(format_id) !== 0) {
      const f = Number(format_id);
      if (!Number.isFinite(f) || f < 1 || f > 9) {
        return res.status(400).json({ success: false, error: 'format_id must be between 1 and 9' });
      }
      payload.format_id = f;
    }
    if (custom_prompt && typeof custom_prompt === 'string' && custom_prompt.trim()) {
      payload.custom_prompt = custom_prompt.trim();
    }
    if (topic && typeof topic === 'string' && topic.trim()) {
      payload.topic = topic.trim();
    }
    // Media passthrough (Request Post with an uploaded photo / before-after /
    // video). SSRF guard: https + Supabase Storage host only.
    if (media_kind && Array.isArray(media_urls) && media_urls.length) {
      const okUrls = media_urls.every((u) => typeof u === 'string' && /^https:\/\/[a-z0-9.-]+\.supabase\.(co|in)\//i.test(u));
      if (okUrls && ['single', 'before_after', 'video'].includes(media_kind)) {
        payload.media_kind = media_kind;
        payload.media_urls = media_urls.slice(0, 10);
      }
    }
    const { data: job, error } = await db.from('agent_jobs').insert({
      tenant_id: FGA_TENANT_ID,
      agent_name: 'content-generation',
      payload,
      status: 'pending',
    }).select('id').single();
    if (error) throw error;
    log.success(`Queued content-generation job ${job.id} (format ${payload.format_id || 'auto'})`);
    res.json({ success: true, job_id: job.id });
  } catch (err) {
    log.error(`content generate failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/admin/finance/report?year=&month= — Financial Command Center
// data: single-roundtrip aggregator for the redesigned Income / Expense /
// Profitability reports. Returns:
//
//   summary:    Top-line cards (total income, total expenses, net profit,
//               profit margin, MRR, setup revenue, recurring expenses,
//               burn rate)
//   monthly:    12-month income / expense / net for the comparison chart
//   income:     Source breakdown, customer ranking, transaction list
//   expenses:   Category breakdown, vendor ranking, recurring list,
//               transaction list
//   profitability: Best month, worst month, profitable months, break-even
//
// Data is FGA-scoped (Patrick's books) but MRR + setup-revenue draws on
// active client tenants too so "recurring revenue" reflects committed
// future revenue, not just YTD cash receipts.
// ---------------------------------------------------------------------------
router.get('/finance/report', async (req, res) => {
  try {
    const db = getServiceClient();
    const now = new Date();
    const year = parseInt(req.query.year) || now.getFullYear();
    const monthParam = req.query.month ? parseInt(req.query.month) : null;

    // ----- FGA ledger (every entry type; P&L uses income/expense only) -----
    const { data: entries, error: entriesErr } = await db
      .from('finance_entries')
      .select('*')
      .eq('tenant_id', FGA_TENANT_ID)
      .gte('date', `${year}-01-01`)
      .lte('date', `${year}-12-31`)
      .order('date', { ascending: false });
    if (entriesErr) throw entriesErr;

    const allEntries = entries || [];
    const income = allEntries.filter((e) => e.entry_type === 'income');
    const expenses = allEntries.filter((e) => e.entry_type === 'expense');
    const equityEntries = allEntries.filter((e) =>
      e.entry_type === 'owner_contribution' || e.entry_type === 'owner_draw');

    // ----- Monthly breakdown (always full selected year — feeds the chart) -----
    const monthly = {};
    for (let m = 1; m <= 12; m++) monthly[m] = { income: 0, expenses: 0, net: 0, income_count: 0, expense_count: 0 };
    let yearIncome = 0;
    let yearExpenses = 0;
    for (const e of allEntries) {
      const month = new Date(e.date).getMonth() + 1;
      const amt = parseFloat(e.amount) || 0;
      if (e.entry_type === 'income') {
        monthly[month].income += amt;
        monthly[month].income_count += 1;
        yearIncome += amt;
      } else if (e.entry_type === 'expense') {
        monthly[month].expenses += amt;
        monthly[month].expense_count += 1;
        yearExpenses += amt;
      }
    }
    for (let m = 1; m <= 12; m++) monthly[m].net = monthly[m].income - monthly[m].expenses;

    // ----- Selected PERIOD (the fix for "changing Month does nothing") -----
    // month supplied → that calendar month; otherwise the whole selected year.
    // Every summary card, breakdown, and transaction list below is period-
    // scoped. Point-in-time metrics (MRR, recurring baseline, burn rate,
    // setup outstanding) are NOT period math and are labeled as such.
    const inPeriod = (e) => !monthParam || new Date(e.date).getMonth() + 1 === monthParam;
    const periodIncome = income.filter(inPeriod);
    const periodExpenses = expenses.filter(inPeriod);
    const periodIncomeTotal = periodIncome.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);
    const periodExpenseTotal = periodExpenses.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);
    const periodNet = periodIncomeTotal - periodExpenseTotal;

    // ----- Income source + customer breakdown (period-scoped) -----
    const sourceMap = {};
    const sourceCounts = {};
    for (const s of INCOME_SOURCES) { sourceMap[s] = 0; sourceCounts[s] = 0; }
    const incomeByCustomer = {};
    for (const e of periodIncome) {
      const amt = parseFloat(e.amount) || 0;
      const src = classifyIncome(e);
      sourceMap[src] += amt;
      sourceCounts[src] += 1;
      const cust = e.customer_name || 'Unattributed';
      if (!incomeByCustomer[cust]) incomeByCustomer[cust] = { customer: cust, ytd: 0, count: 0, last_date: null, last_amount: 0, sources: {} };
      incomeByCustomer[cust].ytd += amt;
      incomeByCustomer[cust].count += 1;
      if (!incomeByCustomer[cust].last_date || e.date > incomeByCustomer[cust].last_date) {
        incomeByCustomer[cust].last_date = e.date;
        incomeByCustomer[cust].last_amount = amt;
      }
      incomeByCustomer[cust].sources[src] = (incomeByCustomer[cust].sources[src] || 0) + amt;
    }
    const customerRanking = Object.values(incomeByCustomer).sort((a, b) => b.ytd - a.ytd).slice(0, 20);

    // ----- Expense category (CANONICAL) + vendor breakdown (period-scoped) -----
    // Categories are normalized at rollup time only — rows are never mutated,
    // so the audit log stays truthful. Raw→canonical remaps are surfaced as a
    // data-quality item.
    const expensesByCategory = {};
    const expensesByVendor = {};
    const categoryRemaps = {};
    let uncategorizedCount = 0;
    for (const e of periodExpenses) {
      const norm = normalizeCategory(e.category);
      if (!e.category) uncategorizedCount += 1;
      if (norm.wasAlias && e.category) {
        categoryRemaps[norm.raw] = categoryRemaps[norm.raw] || { raw: norm.raw, canonical: norm.canonical, count: 0 };
        categoryRemaps[norm.raw].count += 1;
      }
      const cat = norm.canonical;
      const vendor = e.vendor || e.description || 'Unknown';
      const amt = parseFloat(e.amount) || 0;
      if (!expensesByCategory[cat]) expensesByCategory[cat] = { category: cat, amount: 0, count: 0 };
      expensesByCategory[cat].amount += amt;
      expensesByCategory[cat].count += 1;

      if (!expensesByVendor[vendor]) expensesByVendor[vendor] = { vendor, category: cat, amount: 0, count: 0, last_date: null, recurring: false };
      expensesByVendor[vendor].amount += amt;
      expensesByVendor[vendor].count += 1;
      if (!expensesByVendor[vendor].last_date || e.date > expensesByVendor[vendor].last_date) {
        expensesByVendor[vendor].last_date = e.date;
      }
      if (e.recurring) expensesByVendor[vendor].recurring = true;
    }
    const categoryRanking = Object.values(expensesByCategory).sort((a, b) => b.amount - a.amount);
    const vendorRanking = Object.values(expensesByVendor).sort((a, b) => b.amount - a.amount).slice(0, 20);

    // Recurring baseline is point-in-time (latest known recurring charges this
    // year, deduped by vendor), independent of the selected period.
    const recurringByVendor = {};
    for (const e of expenses) {
      if (!e.recurring) continue;
      const vendor = e.vendor || e.description || 'Unknown';
      if (!recurringByVendor[vendor] || e.date > recurringByVendor[vendor].date) {
        recurringByVendor[vendor] = {
          id: e.id,
          vendor,
          category: normalizeCategory(e.category).canonical,
          amount: parseFloat(e.amount) || 0,
          date: e.date,
          frequency: (e.metadata && e.metadata.recurrence_frequency) || 'monthly',
          description: e.description,
        };
      }
    }
    const recurringExpenses = Object.values(recurringByVendor).sort((a, b) => b.amount - a.amount);
    let recurringMonthlyEquiv = 0;
    for (const r of recurringExpenses) {
      const f = (r.frequency || 'monthly').toLowerCase();
      if (f === 'annual' || f === 'yearly') recurringMonthlyEquiv += r.amount / 12;
      else if (f === 'quarterly') recurringMonthlyEquiv += r.amount / 3;
      else recurringMonthlyEquiv += r.amount;
    }

    // ----- Burn rate (avg monthly expenses over active months, year-based) -----
    const monthsWithActivity = Object.values(monthly).filter((m) => m.expenses > 0).length;
    const burnRate = monthsWithActivity > 0 ? yearExpenses / monthsWithActivity : 0;

    // ----- Tenant classification + MRR (the single source of truth) -----
    // Uses core/revenue.js classifyTenant → isBillingActive. Billing and
    // delivery are independent axes: a tenant still onboarding can be
    // billing-active (923A). status==='active' is NOT the MRR filter.
    const { data: allTenants } = await db
      .from('tenants')
      .select('id, name, slug, status, is_demo');
    const tenantIds = (allTenants || []).map((t) => t.id);
    const { data: configRows } = tenantIds.length
      ? await db
          .from('tenant_config')
          .select('tenant_id, key, value')
          .in('tenant_id', tenantIds)
          .in('key', [
            'tier', 'monthly_rate', 'is_complimentary', 'setup_fee', 'setup_fee_paid',
            'billing_active', 'subscription_status', 'trial_ends_at', 'churned_at',
          ])
      : { data: [] };
    const cfgFor = (tid) => (key) =>
      (configRows || []).find((r) => r.tenant_id === tid && r.key === key)?.value;
    const classified = (allTenants || []).map((t) => classifyTenant(t, cfgFor(t.id), FGA_TENANT_ID));
    const paying = classified.filter((c) => c.type === 'paying');
    const mrr = paying.reduce((s, c) => s + c.monthly_rate, 0);
    const clientCounts = classified.reduce((acc, c) => {
      acc[c.type] = (acc[c.type] || 0) + 1;
      return acc;
    }, {});

    // Setup fees: real customers only (never demo/internal). Ledger wins for
    // "collected" (actual cash); config drives "outstanding".
    let setupOutstanding = 0;
    let setupCollectedFromConfig = 0;
    for (const c of classified) {
      if (c.type === 'demo' || c.type === 'internal' || c.is_complimentary) continue;
      const amt = c.setup_fee || 199;
      if (c.setup_fee_paid) setupCollectedFromConfig += amt;
      else if (c.type === 'paying') setupOutstanding += amt;
    }
    let setupFromLedger = 0;
    for (const r of income) {
      if (classifyIncome(r) === 'Setup Fee') setupFromLedger += parseFloat(r.amount) || 0;
    }
    const setupCollected = Math.max(setupFromLedger, setupCollectedFromConfig);

    // ----- Profitability summary (year-based) -----
    const monthArr = Object.entries(monthly).map(([m, v]) => ({ month: parseInt(m), ...v }));
    const profitableMonths = monthArr.filter((m) => m.net > 0).length;
    const activeMonths = monthArr.filter((m) => m.income > 0 || m.expenses > 0);
    const bestIncomeMonth = monthArr.reduce((b, m) => (m.income > b.income ? m : b), { income: 0, month: null });
    const worstExpenseMonth = monthArr.reduce((w, m) => (m.expenses > w.expenses ? m : w), { expenses: 0, month: null });
    const mostProfitableMonth = monthArr.reduce((p, m) => (m.net > p.net ? m : p), { net: -Infinity, month: null });
    const avgIncome = activeMonths.length ? activeMonths.reduce((s, m) => s + m.income, 0) / activeMonths.length : 0;
    const avgExpense = activeMonths.length ? activeMonths.reduce((s, m) => s + m.expenses, 0) / activeMonths.length : 0;

    // ----- Data quality (accountant-readiness flags — all computed, none invented) -----
    const dataQuality = [];
    if (uncategorizedCount > 0) {
      dataQuality.push({
        id: 'uncategorized_expenses', severity: 'warn', count: uncategorizedCount,
        label: `${uncategorizedCount} expense${uncategorizedCount === 1 ? '' : 's'} in the period have no category`,
        detail: 'Uncategorized spend lands in "Other" on the P&L. Categorize before closing the period.',
      });
    }
    const remapList = Object.values(categoryRemaps).sort((a, b) => b.count - a.count);
    if (remapList.length > 0) {
      dataQuality.push({
        id: 'category_aliases', severity: 'info', count: remapList.length,
        label: `${remapList.length} legacy category name${remapList.length === 1 ? '' : 's'} normalized for reporting`,
        detail: remapList.map((r) => `"${r.raw}" → ${r.canonical} (${r.count})`).join(' · '),
      });
    }
    const incomeNoCustomer = periodIncome.filter((e) => !e.customer_name).length;
    if (incomeNoCustomer > 0) {
      dataQuality.push({
        id: 'income_without_customer', severity: 'warn', count: incomeNoCustomer,
        label: `${incomeNoCustomer} income transaction${incomeNoCustomer === 1 ? '' : 's'} not linked to a customer`,
        detail: 'Client revenue reports undercount until these are attributed.',
      });
    }
    // Duplicate suspects: same vendor + amount + date booked twice this year.
    const dupKeys = {};
    for (const e of expenses) {
      const k = `${(e.vendor || e.description || '').toLowerCase()}|${e.amount}|${e.date}`;
      dupKeys[k] = (dupKeys[k] || 0) + 1;
    }
    const dupCount = Object.values(dupKeys).filter((n) => n > 1).length;
    if (dupCount > 0) {
      dataQuality.push({
        id: 'duplicate_suspects', severity: 'warn', count: dupCount,
        label: `${dupCount} possible duplicate expense${dupCount === 1 ? '' : 's'} (same vendor, amount, and date)`,
        detail: 'Review before year-end so nothing is double-counted.',
      });
    }
    let pendingReview = 0;
    try {
      const { count } = await db
        .from('internal_expenses')
        .select('id', { count: 'exact', head: true })
        .eq('review_status', 'pending');
      pendingReview = count || 0;
    } catch (_) { /* table optional */ }
    if (pendingReview > 0) {
      dataQuality.push({
        id: 'pending_review', severity: 'warn', count: pendingReview,
        label: `${pendingReview} uploaded expense${pendingReview === 1 ? '' : 's'} waiting for review`,
        detail: 'Pending uploads are NOT in the books until approved.',
      });
    }
    for (const c of classified) {
      if (c.type === 'inactive' && c.monthly_rate > 0) {
        dataQuality.push({
          id: `unclassified_billing_${c.slug}`, severity: 'info',
          label: `${c.name} has a $${c.monthly_rate}/mo rate but is not billing`,
          detail: 'Excluded from MRR. Zero the rate, mark complimentary, or activate billing to resolve.',
        });
      }
      if (c.type === 'demo' && c.monthly_rate > 0) {
        dataQuality.push({
          id: `demo_rate_${c.slug}`, severity: 'warn',
          label: `Demo tenant ${c.name} has a nonzero monthly rate`,
          detail: 'Demo tenants never bill; the rate should be 0.',
        });
      }
    }
    if (setupOutstanding > 0) {
      dataQuality.push({
        id: 'setup_outstanding', severity: 'info',
        label: `$${setupOutstanding} in setup fees not yet collected`,
        detail: 'Owed by billing-active customers whose setup fee is unpaid.',
      });
    }
    if (process.env.STRIPE_REVENUE_AUTHORITATIVE !== 'true') {
      dataQuality.push({
        id: 'stripe_not_authoritative', severity: 'info',
        label: 'Stripe is not yet the authoritative revenue source',
        detail: 'Revenue books via webhook + manual entries; Mercury deposits record as transfers. Flip STRIPE_REVENUE_AUTHORITATIVE after the next webhook-booked charge verifies.',
      });
    }

    // ----- Insights (computed from the numbers above — never invented) -----
    const insights = [];
    if (paying.length > 0) {
      insights.push({
        id: 'mrr_bridge', tone: 'info',
        text: `MRR $${mrr.toLocaleString()} = ${paying.map((c) => `${c.name} $${c.monthly_rate.toLocaleString()}`).join(' + ')}.`,
      });
    }
    if (customerRanking.length > 0 && periodIncomeTotal > 0) {
      const top = customerRanking[0];
      const share = Math.round((top.ytd / periodIncomeTotal) * 100);
      if (share >= 50) {
        insights.push({
          id: 'concentration', tone: 'warn',
          text: `Revenue concentration: ${top.customer} is ${share}% of period income.`,
        });
      }
    }
    const feeCats = ['Payment Processing', 'Bank & Payout Fees'];
    const feeTotal = categoryRanking.filter((c) => feeCats.includes(c.category)).reduce((s, c) => s + c.amount, 0);
    if (feeTotal > 0 && periodIncomeTotal > 0) {
      insights.push({
        id: 'processing_fees', tone: 'info',
        text: `Payment and payout fees are ${(Math.round((feeTotal / periodIncomeTotal) * 1000) / 10).toFixed(1)}% of period income ($${feeTotal.toFixed(2)}).`,
      });
    }
    if (recurringMonthlyEquiv > 0) {
      const coverage = mrr > 0 ? Math.round((mrr / recurringMonthlyEquiv) * 100) : 0;
      insights.push({
        id: 'recurring_coverage', tone: coverage >= 100 ? 'good' : 'warn',
        text: coverage >= 100
          ? `MRR covers recurring expenses ${(coverage / 100).toFixed(1)}x ($${mrr.toLocaleString()} vs $${recurringMonthlyEquiv.toFixed(0)}/mo).`
          : `MRR covers ${coverage}% of the $${recurringMonthlyEquiv.toFixed(0)}/mo recurring baseline.`,
      });
    }
    if (worstExpenseMonth.month && worstExpenseMonth.expenses > avgExpense * 1.5 && avgExpense > 0) {
      const monthName = new Date(year, worstExpenseMonth.month - 1, 1).toLocaleString('en-US', { month: 'long' });
      insights.push({
        id: 'expense_spike', tone: 'info',
        text: `${monthName} was the heaviest spend month ($${Math.round(worstExpenseMonth.expenses).toLocaleString()}, ${(worstExpenseMonth.expenses / avgExpense).toFixed(1)}x the monthly average).`,
      });
    }
    if (periodNet < 0) {
      insights.push({
        id: 'operating_loss', tone: 'warn',
        text: `Operating at a loss for the selected period: -$${Math.abs(Math.round(periodNet)).toLocaleString()}. Normal for launch year; watch the trend, not the level.`,
      });
    }
    const excludedNote = [];
    if (clientCounts.demo) excludedNote.push(`${clientCounts.demo} demo`);
    if (clientCounts.internal) excludedNote.push(`${clientCounts.internal} internal`);
    if (clientCounts.inactive) excludedNote.push(`${clientCounts.inactive} inactive`);
    if (clientCounts.complimentary) excludedNote.push(`${clientCounts.complimentary} complimentary`);
    if (excludedNote.length) {
      insights.push({
        id: 'excluded_tenants', tone: 'info',
        text: `Client metrics count paying customers only — ${excludedNote.join(', ')} tenant${excludedNote.length === 1 && !excludedNote[0].startsWith('1 ') ? 's are' : '(s) are'} excluded.`,
      });
    }

    res.json({
      success: true,
      year,
      month: monthParam,
      period: {
        scope: monthParam ? 'month' : 'year',
        label: monthParam
          ? `${new Date(year, monthParam - 1, 1).toLocaleString('en-US', { month: 'long' })} ${year}`
          : `${year}${year === now.getFullYear() ? ' year to date' : ''}`,
        year_income: yearIncome,
        year_expenses: yearExpenses,
      },
      summary: {
        total_income: periodIncomeTotal,
        total_expenses: periodExpenseTotal,
        net_profit: periodNet,
        profit_margin: periodIncomeTotal > 0 ? Math.round((periodNet / periodIncomeTotal) * 100) : null,
        mrr,
        arr: mrr * 12,
        setup_revenue_collected: setupCollected,
        setup_revenue_outstanding: setupOutstanding,
        recurring_expense_monthly: Math.round(recurringMonthlyEquiv * 100) / 100,
        burn_rate: Math.round(burnRate * 100) / 100,
        income_count: periodIncome.length,
        expense_count: periodExpenses.length,
        active_paying_clients: paying.length,
        avg_revenue_per_paying_client: paying.length ? Math.round(mrr / paying.length) : 0,
        owner_contributions: equityEntries
          .filter((e) => e.entry_type === 'owner_contribution')
          .reduce((s, e) => s + (parseFloat(e.amount) || 0), 0),
        owner_draws: equityEntries
          .filter((e) => e.entry_type === 'owner_draw')
          .reduce((s, e) => s + (parseFloat(e.amount) || 0), 0),
      },
      monthly,
      income: {
        by_source: Object.entries(sourceMap)
          .filter(([, v]) => v > 0)
          .map(([source, amount]) => ({ source, amount, count: sourceCounts[source] || 0 }))
          .sort((a, b) => b.amount - a.amount),
        by_customer: customerRanking,
        transactions: periodIncome.map((e) => ({
          id: e.id,
          date: e.date,
          customer_name: e.customer_name,
          description: e.description,
          job_type: e.job_type,
          category: e.category,
          amount: parseFloat(e.amount) || 0,
          source: classifyIncome(e),
          recurring: !!e.recurring,
        })),
      },
      expenses: {
        by_category: categoryRanking,
        by_vendor: vendorRanking,
        recurring: recurringExpenses,
        category_remaps: remapList,
        transactions: periodExpenses.map((e) => ({
          id: e.id,
          date: e.date,
          vendor: e.vendor || e.description || 'Unknown',
          description: e.description,
          category: normalizeCategory(e.category).canonical,
          raw_category: e.category,
          amount: parseFloat(e.amount) || 0,
          recurring: !!e.recurring,
          frequency: (e.metadata && e.metadata.recurrence_frequency) || (e.recurring ? 'monthly' : null),
        })),
      },
      profitability: {
        profitable_months: profitableMonths,
        active_months: activeMonths.length,
        best_income_month: bestIncomeMonth.month,
        best_income_amount: bestIncomeMonth.income,
        worst_expense_month: worstExpenseMonth.month,
        worst_expense_amount: worstExpenseMonth.expenses,
        most_profitable_month: mostProfitableMonth.month,
        most_profitable_net: mostProfitableMonth.net === -Infinity ? 0 : mostProfitableMonth.net,
        avg_monthly_income: avgIncome,
        avg_monthly_expense: avgExpense,
        break_even_revenue: avgExpense,
      },
      clients: {
        counts: {
          total: classified.length,
          paying: clientCounts.paying || 0,
          demo: clientCounts.demo || 0,
          internal: clientCounts.internal || 0,
          inactive: clientCounts.inactive || 0,
          complimentary: clientCounts.complimentary || 0,
        },
        list: classified.sort((a, b) => b.monthly_rate - a.monthly_rate),
      },
      insights,
      data_quality: dataQuality,
    });
  } catch (err) {
    log.error(`Finance report failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/admin/dashboard-summary — Single consolidated payload for the
// Owner Command Center dashboard. Aggregates everything the front page
// needs in ONE roundtrip so the dashboard loads fast and every metric
// uses the same source-of-truth definitions.
//
// Sections returned:
//   - greeting:  { hour-bucket, monthly_active_revenue, pipeline_count, attention_count }
//   - attention: needs-action list (typed alerts with severity + action link)
//   - metrics:   primary card grid (8 numbers) + secondary (8 numbers)
//   - pipeline:  founder pipeline stage counts + recent activity
//   - revenue:   MRR, setup fees collected, avg revenue per customer, plan mix
//   - health:    client health summary (counts by category + at-risk list)
//   - onboarding:in-progress onboardings, target launch dates, stalled list
//   - agents:    agent status banner (active/on-watch/setup/offline counts)
//   - platform:  failed automations 24h, integrations needing attention
//
// All sections are tenant-isolated where applicable. FGA platform tenant
// data (Patrick's own sales pipeline) is kept separate from CLIENT
// aggregates so the dashboard never confuses "us" with "our customers".
// ---------------------------------------------------------------------------
router.get('/dashboard-summary', async (req, res) => {
  try {
    const db = getServiceClient();
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const iso = (ms) => new Date(ms).toISOString();
    const since24h = iso(now - day);
    const since7d = iso(now - 7 * day);
    const since30d = iso(now - 30 * day);
    const in48h = iso(now + 2 * day);

    // ----- TENANTS (clients only — exclude FGA itself + demos) -----
    const { data: allTenants } = await db
      .from('tenants')
      .select('id, name, slug, vertical, status, is_demo, created_at, owner_email');
    const tenants = (allTenants || []).filter((t) => t.id !== FGA_TENANT_ID && !t.is_demo);
    const tenantIds = tenants.map((t) => t.id);

    // ----- TENANT CONFIG (tier, monthly_rate, onboarding state, etc.) -----
    const { data: configRows } = tenantIds.length
      ? await db
          .from('tenant_config')
          .select('tenant_id, key, value')
          .in('tenant_id', tenantIds)
          .in('key', [
            'tier',
            'monthly_rate',
            'is_complimentary',
            'setup_fee',
            'setup_fee_paid',
            'business_name',
            'payment_failed_at',
            'trial_ends_at',
            'onboarding_completed_at',
            'go_live_at',
            'target_launch_at',
            'subscription_status',
            'billing_active',
            'first_charged_at',
            'churned_at',
          ])
      : { data: [] };

    const cfg = (tid, key) =>
      (configRows || []).find((c) => c.tenant_id === tid && c.key === key)?.value;

    // ----- ACTIVITY DATA (leads, content, agent_jobs, conversations) -----
    const [
      leadsRes,
      contentRes,
      jobsRes,
      convRes,
      voiceRes,
      webchatRes,
      supportRes,
      outreachPendingRes,
      contentPendingRes,
    ] = await Promise.all([
      // Reconciliation pass (2026-07-22): every pull below is 30d-scoped,
      // newest-first, and EXPLICITLY limited. PostgREST silently caps
      // unbounded selects at 1000 rows — the old unbounded pulls returned an
      // arbitrary slice, which is how "Leads Captured (30d)" showed an
      // all-time-but-truncated number and the agent banner read the OLDEST
      // month of jobs ("0 ACTIVE / 31 SETUP REQUIRED" while 30 agents had
      // completed within 24h).
      tenantIds.length
        ? db
            .from('leads')
            .select('tenant_id, lifecycle_stage, status, created_at')
            .in('tenant_id', tenantIds)
            .gte('created_at', since30d)
            .order('created_at', { ascending: false })
            .limit(10000)
        : Promise.resolve({ data: [] }),
      tenantIds.length
        ? db
            .from('content_drafts')
            .select('tenant_id, status, created_at')
            .in('tenant_id', tenantIds)
            .gte('created_at', since30d)
            .order('created_at', { ascending: false })
            .limit(10000)
        : Promise.resolve({ data: [] }),
      tenantIds.length
        ? db
            .from('agent_jobs')
            .select('tenant_id, agent_name, status, created_at')
            .in('tenant_id', tenantIds)
            .gte('created_at', since30d)
            .order('created_at', { ascending: false })
            .limit(10000)
        : Promise.resolve({ data: [] }),
      tenantIds.length
        ? db
            .from('conversations')
            .select('tenant_id, channel, direction, created_at')
            .in('tenant_id', tenantIds)
            .gte('created_at', since30d)
            .order('created_at', { ascending: false })
            .limit(10000)
        : Promise.resolve({ data: [] }),
      // Voice + web chat counters are FGA-scoped: this dashboard runs
      // Patrick's business, and each counter must match the inbox it links
      // to (/admin/voice, /admin/web-chats — both FGA by default). Client
      // tenants' conversations live in the Client Activity feed instead.
      db
        .from('voice_calls')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', FGA_TENANT_ID)
        .gte('created_at', since30d)
        .then((r) => r, () => ({ count: 0 })),
      db
        .from('conversations')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', FGA_TENANT_ID)
        .eq('channel', 'web_chat')
        .eq('direction', 'inbound')
        .gte('created_at', since30d)
        .then((r) => r, () => ({ count: 0 })),
      db
        .from('support_threads')
        .select('id, tenant_id, status, created_at, last_message_at')
        .in('status', ['open', 'pending'])
        .then((r) => r, () => ({ data: [] })),
      // "Awaiting review" = EMAIL drafts on leads still in the new_lead
      // stage. A draft only needs Patrick when the lead hasn't been
      // contacted/rejected/won yet, so we gate on lead.status='new_lead'.
      // This excludes facebook_dm drafts (manual channel), leftover drafts
      // on leads already worked via FB DM (status 'contacted'), and drafts
      // on rejected/won/customer leads — matching what the Pipeline
      // actually surfaces as reviewable.
      countNewLeadEmailDrafts(db),
      db
        .from('content_drafts')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', FGA_TENANT_ID)
        .eq('status', 'pending')
        .then((r) => r, () => ({ count: 0 })),
    ]);

    // ----- PER-TENANT ROLLUPS -----
    const perTenant = tenants.map((t) => {
      const tier = cfg(t.id, 'tier') || 'growth';
      const rateRaw = cfg(t.id, 'monthly_rate');
      const monthlyRate =
        rateRaw !== undefined && rateRaw !== null && rateRaw !== ''
          ? Number(rateRaw)
          : tier === 'scale'
          ? 399
          : tier === 'complimentary'
          ? 0
          : 249;
      const isComplimentary = cfg(t.id, 'is_complimentary') === 'true';
      const setupPaid = cfg(t.id, 'setup_fee_paid') === 'true';
      const setupFeeAmt = Number(cfg(t.id, 'setup_fee') || 199);
      const onboardingDone = cfg(t.id, 'onboarding_completed_at') || cfg(t.id, 'go_live_at');
      const tLeads = (leadsRes.data || []).filter((l) => l.tenant_id === t.id);
      const tContent = (contentRes.data || []).filter((c) => c.tenant_id === t.id);
      const tJobs = (jobsRes.data || []).filter((j) => j.tenant_id === t.id);
      const tConv = (convRes.data || []).filter((c) => c.tenant_id === t.id);
      const lastActivity = [
        ...tLeads.map((l) => l.created_at),
        ...tContent.map((c) => c.created_at),
        ...tJobs.map((j) => j.created_at),
        ...tConv.map((c) => c.created_at),
      ]
        .filter(Boolean)
        .sort()
        .reverse()[0] || null;

      let health = 'red';
      if (t.status === 'active' && lastActivity) {
        const days = (now - new Date(lastActivity).getTime()) / day;
        if (days <= 7) health = 'green';
        else if (days <= 21) health = 'yellow';
      } else if (t.status !== 'active') {
        health = 'onboarding';
      }

      const inOnboarding = t.status !== 'active' || !onboardingDone;
      // Billing axis (independent of delivery/go-live): does this tenant
      // contribute MRR right now? See core/revenue.js.
      const subscriptionStatus = cfg(t.id, 'subscription_status') || null;
      const billingActive = isBillingActive({
        isComplimentary,
        monthlyRate,
        churnedAt: cfg(t.id, 'churned_at') || null,
        subscriptionStatus,
        billingActiveFlag: cfg(t.id, 'billing_active') === 'true',
        trialEndsAt: cfg(t.id, 'trial_ends_at') || null,
        status: t.status,
      }, now);
      return {
        id: t.id,
        slug: t.slug,
        name: cfg(t.id, 'business_name') || t.name,
        vertical: t.vertical,
        status: t.status,
        tier,
        monthly_rate: monthlyRate,
        is_complimentary: isComplimentary,
        setup_fee_paid: setupPaid,
        setup_fee_amt: setupFeeAmt,
        in_onboarding: inOnboarding,
        billing_active: billingActive,
        subscription_status: subscriptionStatus,
        first_charged_at: cfg(t.id, 'first_charged_at') || null,
        last_activity: lastActivity,
        health,
        lead_count: tLeads.length,
        content_count: tContent.length,
        payment_failed_at: cfg(t.id, 'payment_failed_at') || null,
        trial_ends_at: cfg(t.id, 'trial_ends_at') || null,
        target_launch_at: cfg(t.id, 'target_launch_at') || null,
      };
    });

    // ----- REVENUE / MRR -----
    // MRR recognizes on BILLING, not on go-live: a customer past their trial
    // (or with an active Stripe subscription) is paying us even while their
    // app/site is still being built. Their onboarding delay is a delivery
    // problem, not a revenue one.
    const mrr = perTenant
      .filter((t) => t.billing_active)
      .reduce((s, t) => s + t.monthly_rate, 0);
    const setupRevenueFromConfig = perTenant
      .filter((t) => t.setup_fee_paid)
      .reduce((s, t) => s + (t.setup_fee_amt || 0), 0);
    // 2026-06-09: prefer the FGA finance_entries ledger (actual recorded
    // setup-fee income) as the source of truth — tenant_config
    // setup_fee_paid flags aren't always set when income is booked.
    let setupRevenueFromLedger = 0;
    try {
      const yearStart = `${new Date(now).getUTCFullYear()}-01-01`;
      const yearEnd = `${new Date(now).getUTCFullYear()}-12-31`;
      const { data: ledgerIncome } = await db
        .from('finance_entries')
        .select('amount, job_type, category, description')
        .eq('tenant_id', FGA_TENANT_ID)
        .eq('entry_type', 'income')
        .gte('date', yearStart)
        .lte('date', yearEnd);
      for (const r of ledgerIncome || []) {
        const tags = `${r.job_type || ''} ${r.category || ''} ${r.description || ''}`.toLowerCase();
        if (/setup\s*fee|onboarding\s*fee|one[-\s]?time\s*setup/.test(tags)) {
          setupRevenueFromLedger += parseFloat(r.amount) || 0;
        }
      }
    } catch (_) { /* fall back to config */ }
    const setupRevenue = Math.max(setupRevenueFromLedger, setupRevenueFromConfig);
    const payingCount = perTenant.filter((t) => t.billing_active).length;
    const avgRev = payingCount ? Math.round(mrr / payingCount) : 0;
    const planMix = perTenant.reduce((acc, t) => {
      acc[t.tier] = (acc[t.tier] || 0) + 1;
      return acc;
    }, {});

    // ----- HEALTH BUCKETS -----
    const healthCounts = perTenant.reduce(
      (acc, t) => {
        acc[t.health] = (acc[t.health] || 0) + 1;
        return acc;
      },
      { green: 0, yellow: 0, red: 0, onboarding: 0 }
    );
    const atRisk = perTenant
      .filter((t) => t.health === 'red' || t.health === 'yellow')
      .slice(0, 6)
      .map((t) => ({
        id: t.id,
        name: t.name,
        health: t.health,
        last_activity: t.last_activity,
        recommendation:
          t.health === 'red'
            ? t.in_onboarding
              ? 'Complete setup checklist'
              : 'No activity in 21+ days — schedule check-in'
            : 'Engagement dipping — send a status nudge',
      }));

    // ----- ONBOARDING -----
    const onboardingClients = perTenant.filter((t) => t.in_onboarding);

    // ----- FOUNDER (FGA) PIPELINE -----
    const { data: founderLeads } = await db
      .from('leads')
      .select('id, status, lifecycle_stage, company_name, created_at')
      .eq('tenant_id', FGA_TENANT_ID);
    const founderByStatus = {};
    const founderByLifecycle = {};
    for (const l of founderLeads || []) {
      const s = l.status || 'unknown';
      const lc = l.lifecycle_stage || 'unknown';
      founderByStatus[s] = (founderByStatus[s] || 0) + 1;
      founderByLifecycle[lc] = (founderByLifecycle[lc] || 0) + 1;
    }
    const recentProspects = (founderLeads || [])
      .slice()
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
      .slice(0, 5)
      .map((l) => ({
        id: l.id,
        name: l.company_name,
        status: l.status,
        lifecycle_stage: l.lifecycle_stage,
        created_at: l.created_at,
      }));

    // ----- AGENTS (whole fleet: FGA + client-serving) -----
    // Rewritten 2026-07-22 (reconciliation pass). The old version pulled 30
    // days of FGA-only jobs with NO limit — PostgREST capped it at 1000 rows
    // (the OLDEST slice of ~5k), so every agent's "last run" looked 8-30d
    // stale and the banner read "0 ACTIVE / 31 SETUP REQUIRED" while 30
    // agents had completed within 24h. Now: last-7d roster, newest-first,
    // explicit limit, cross-tenant (the fleet serves clients too — and the
    // banner links to Agent Hub, which is cross-tenant, so the two agree).
    // Vocabulary: active = ok in 24h · on_watch = failed in 24h · idle =
    // ran 1-7d ago. There is no "setup required" — that label implied
    // missing configuration that was never the issue.
    const since7dIso = iso(new Date(now - 7 * day));
    const { data: fleetJobs } = await db
      .from('agent_jobs')
      .select('tenant_id, agent_name, status, created_at, completed_at')
      .gte('created_at', since7dIso)
      .order('created_at', { ascending: false })
      .limit(9000);
    const agentLastRun = {};
    const agentLast24hStatus = {};
    for (const j of fleetJobs || []) {
      const ts = j.completed_at || j.created_at;
      if (!agentLastRun[j.agent_name] || agentLastRun[j.agent_name] < ts) {
        agentLastRun[j.agent_name] = ts;
      }
      if (new Date(ts).getTime() >= now - day) {
        // Keep WORST status from last 24h: failed > processing > completed
        const prev = agentLast24hStatus[j.agent_name];
        if (j.status === 'failed') agentLast24hStatus[j.agent_name] = 'failed';
        else if (!prev || prev === 'completed') agentLast24hStatus[j.agent_name] = j.status;
      }
    }
    const agentStatuses = Object.keys(agentLastRun).sort().map((name) => {
      const last = agentLastRun[name] || null;
      const status24h = agentLast24hStatus[name];
      let health = 'idle';
      if (status24h === 'failed') health = 'on_watch';
      else if (status24h === 'completed' || status24h === 'processing') health = 'active';
      return { name, health, last_run: last };
    });
    const agentCounts = agentStatuses.reduce(
      (acc, a) => {
        acc[a.health] = (acc[a.health] || 0) + 1;
        acc.total += 1;
        return acc;
      },
      // setup_required/offline kept at 0 for payload back-compat with any
      // cached client build still reading the old keys.
      { total: 0, active: 0, on_watch: 0, idle: 0, setup_required: 0, offline: 0 }
    );

    // ----- FAILED AUTOMATIONS (last 24h, all tenants — from the same
    // bounded fleet query the banner uses, so the two can't diverge) -----
    const failedAutomations24hAll = (fleetJobs || []).filter(
      (j) => j.status === 'failed' && j.created_at >= since24h
    ).length;
    const failedAutomations24h = failedAutomations24hAll;
    const failedFga24h = (fleetJobs || []).filter(
      (j) => j.tenant_id === FGA_TENANT_ID && j.status === 'failed' && j.created_at >= since24h
    ).length;

    // ----- LEADS / CONTENT 30d (client aggregates; now genuinely 30d) -----
    const leadsCaptured30d = (leadsRes.data || []).length;
    const contentCreated30d = (contentRes.data || []).length;
    const voiceCalls30d = voiceRes.count || 0;
    const webChats30d = webchatRes.count || 0;

    // ----- SMS / EMAIL ACTIVITY (proxied via conversations) -----
    const smsActivity30d = (convRes.data || []).filter(
      (c) => c.channel === 'sms' && c.direction === 'outbound'
    ).length;
    const emailActivity30d = (convRes.data || []).filter(
      (c) => c.channel === 'email' && c.direction === 'outbound'
    ).length;

    // ----- ATTENTION ITEMS (operational alerts) -----
    const attention = [];
    // Stalled onboardings
    for (const t of perTenant.filter((x) => x.in_onboarding)) {
      const ageDays = (now - new Date(t.last_activity || iso(now)).getTime()) / day;
      if (!t.last_activity || ageDays > 2) {
        attention.push({
          id: `onboard-${t.id}`,
          type: 'stalled_onboarding',
          severity: ageDays > 5 ? 'high' : 'medium',
          client_id: t.id,
          client_name: t.name,
          message: 'Onboarding stalled',
          detail: t.last_activity
            ? `Last step ${Math.floor(ageDays)}d ago`
            : 'No setup activity yet',
          action_label: 'Open Onboarding',
          action_link: `/admin/onboarding`,
        });
      }
    }
    // Payment failures
    for (const t of perTenant.filter((x) => x.payment_failed_at)) {
      attention.push({
        id: `pay-${t.id}`,
        type: 'payment_failure',
        severity: 'high',
        client_id: t.id,
        client_name: t.name,
        message: 'Payment failed',
        detail: `Failed at ${new Date(t.payment_failed_at).toLocaleDateString()}`,
        action_label: 'Open Client',
        action_link: `/admin/clients`,
      });
    }
    // Expiring trials within 48h
    for (const t of perTenant.filter(
      (x) => x.trial_ends_at && x.trial_ends_at < in48h && x.trial_ends_at > iso(now)
    )) {
      attention.push({
        id: `trial-${t.id}`,
        type: 'trial_expiring',
        severity: 'medium',
        client_id: t.id,
        client_name: t.name,
        message: 'Trial ending in <48h',
        detail: `Ends ${new Date(t.trial_ends_at).toLocaleString()}`,
        action_label: 'Open Client',
        action_link: `/admin/clients`,
      });
    }
    // Pending outreach
    if ((outreachPendingRes.count || 0) > 0) {
      attention.push({
        id: 'pending-outreach',
        type: 'pending_outreach',
        severity: 'medium',
        message: `${outreachPendingRes.count} outreach draft${outreachPendingRes.count === 1 ? '' : 's'} waiting for your approval`,
        detail: 'Read each one and approve or discard — no hunting required',
        action_label: 'Open Review Queue',
        action_link: '/admin/review',
      });
    }
    // Pending content
    if ((contentPendingRes.count || 0) > 0) {
      attention.push({
        id: 'pending-content',
        type: 'pending_content',
        severity: 'low',
        message: `${contentPendingRes.count} content draft${contentPendingRes.count === 1 ? '' : 's'} pending approval`,
        detail: 'Approve to schedule via Buffer',
        action_label: 'Open Approvals',
        action_link: '/admin/content',
      });
    }
    // Open support — exclude demo-tenant seed threads (Apex Plumbing);
    // tenant-less threads (direct emails to support@) still count.
    const demoIdSet = new Set((allTenants || []).filter((t) => t.is_demo).map((t) => t.id));
    const openSupport = (supportRes.data || []).filter(
      (s) => !s.tenant_id || !demoIdSet.has(s.tenant_id)
    ).length;
    if (openSupport > 0) {
      attention.push({
        id: 'open-support',
        type: 'support_open',
        severity: 'medium',
        message: `${openSupport} open support thread${openSupport === 1 ? '' : 's'}`,
        detail: 'Unresolved customer requests',
        action_label: 'Open Support',
        action_link: '/admin/support',
      });
    }
    // Failed FGA agent jobs in last 24h
    if (failedFga24h > 0) {
      attention.push({
        id: 'fga-failed-jobs',
        type: 'agent_failure',
        severity: 'medium',
        message: `${failedFga24h} agent run${failedFga24h === 1 ? '' : 's'} failed (24h)`,
        detail: 'Investigate before next scheduled run',
        action_label: 'Open Agent Hub',
        action_link: '/admin/agent-hub',
      });
    }
    // Owner actions from the REAL attention_queue (sales handoffs, drip
    // replies, cap warnings…) — the same rows the mobile "Needs you" inbox
    // shows, so web and mobile finally agree on what needs Patrick.
    // (2026-07-22 reconciliation: this panel previously rebuilt a parallel
    // ad-hoc list and never consulted attention_queue at all.)
    try {
      const { data: aqItems } = await db
        .from('attention_queue')
        .select('id, type, severity, title, summary, entity_type, entity_id, produced_at')
        .eq('tenant_id', FGA_TENANT_ID)
        .is('resolved_at', null)
        .order('produced_at', { ascending: false })
        .limit(20);
      for (const a of aqItems || []) {
        const leadLink = a.entity_type === 'lead' && a.entity_id
          ? `/admin/pipeline/${a.entity_id}` : '/admin/growth';
        attention.push({
          id: `aq-${a.id}`,
          type: a.type,
          severity: a.severity === 'red' ? 'high' : a.severity === 'amber' ? 'medium' : 'low',
          message: a.title,
          detail: (a.summary || '').slice(0, 160),
          action_label: a.entity_type === 'lead' && a.entity_id ? 'Open Lead' : 'Open',
          action_link: leadLink,
        });
      }
    } catch (aqErr) {
      log.warn(`attention_queue merge failed (non-fatal): ${aqErr.message}`);
    }
    // Sort by severity high > medium > low
    const sevRank = { high: 0, medium: 1, low: 2 };
    attention.sort((a, b) => (sevRank[a.severity] || 9) - (sevRank[b.severity] || 9));

    // ----- METRIC DRILL-DOWN COUNTS -----
    const activeClients = perTenant.filter((t) => t.status === 'active').length;
    const onboardingCount = onboardingClients.length;
    // "Prospects in flight" means IN FLIGHT — closed leads (won/lost/etc.)
    // no longer inflate the headline count. The full list, including closed,
    // stays available as pipeline.total_leads.
    const { CLOSED_STATUSES } = require('../../core/growth/lead-status');
    const pipelineCount = (founderLeads || []).filter((l) => !CLOSED_STATUSES.has(l.status)).length;
    const totalFounderLeads = (founderLeads || []).length;
    const activeAgentCount = agentCounts.active;
    const pendingApprovals = (outreachPendingRes.count || 0) + (contentPendingRes.count || 0);

    res.json({
      success: true,
      generated_at: iso(now),
      greeting: {
        hour: new Date(now).getHours(),
        mrr,
        active_clients: activeClients,
        in_onboarding: onboardingCount,
        pipeline_count: pipelineCount,
        attention_count: attention.length,
      },
      attention,
      metrics: {
        mrr,
        active_clients: activeClients,
        in_onboarding: onboardingCount,
        pipeline_count: pipelineCount,
        active_agents: activeAgentCount,
        failed_automations_24h: failedAutomations24h,
        leads_captured_30d: leadsCaptured30d,
        content_created_30d: contentCreated30d,
        voice_calls_30d: voiceCalls30d,
        web_chats_30d: webChats30d,
        sms_activity_30d: smsActivity30d,
        email_activity_30d: emailActivity30d,
        open_support: openSupport,
        pending_approvals: pendingApprovals,
        setup_revenue: setupRevenue,
      },
      pipeline: {
        total_leads: totalFounderLeads,
        in_flight: pipelineCount,
        by_status: founderByStatus,
        by_lifecycle: founderByLifecycle,
        recent: recentProspects,
      },
      revenue: {
        mrr,
        setup_revenue: setupRevenue,
        avg_revenue_per_customer: avgRev,
        plan_mix: planMix,
        active_paying_clients: payingCount,
      },
      health: {
        counts: healthCounts,
        at_risk: atRisk,
      },
      onboarding: {
        total: onboardingCount,
        clients: onboardingClients.map((t) => ({
          id: t.id,
          name: t.name,
          vertical: t.vertical,
          status: t.status,
          target_launch_at: t.target_launch_at,
          last_activity: t.last_activity,
        })),
      },
      agents: {
        counts: agentCounts,
        statuses: agentStatuses,
      },
      platform: {
        failed_automations_24h: failedAutomations24h,
        failed_fga_24h: failedFga24h,
        open_support: openSupport,
        pending_approvals: pendingApprovals,
      },
      clients: perTenant
        .slice()
        .sort((a, b) => b.monthly_rate - a.monthly_rate)
        .slice(0, 8),
    });
  } catch (err) {
    log.error(`Admin dashboard-summary failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/admin/activity-feed — Recent operational events across the
// platform for the dashboard's Recent Activity panel. Pulls a unified
// stream from leads, content_drafts, agent_jobs (failures), conversations,
// and tenants (new client created). Returns the latest N events sorted
// by timestamp.
// ---------------------------------------------------------------------------
router.get('/activity-feed', async (req, res) => {
  try {
    const db = getServiceClient();
    const limit = Math.min(Number(req.query.limit) || 25, 100);
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    // FGA-ONLY (2026-07-22, Command Center purpose directive): this feed is
    // Patrick's business — FGA leads, replies, content, failures, plus
    // new-client signups (a company-level win). The short-lived
    // scope=clients variant is REMOVED: client tenants' operational events
    // do not appear in any feed. The one approved cross-tenant surface is
    // the Information Center (/api/admin/info-center), which serves
    // counts/health/status only — never customer content.
    const scope = 'fga';
    const scoped = (q) => q.eq('tenant_id', FGA_TENANT_ID);

    // Pull a wide net then slice to N.
    const [tenantsRes, leadsRes, contentRes, failuresRes, conversationsRes] = await Promise.all([
      scope === 'fga'
        ? db.from('tenants').select('id, name, slug, created_at, vertical, status').gte('created_at', since)
        : Promise.resolve({ data: [] }),
      scoped(db.from('leads').select('id, tenant_id, company_name, name, lifecycle_stage, created_at').gte('created_at', since)).order('created_at', { ascending: false }).limit(80),
      scoped(db.from('content_drafts').select('id, tenant_id, headline, status, created_at').gte('created_at', since)).order('created_at', { ascending: false }).limit(40),
      scoped(db.from('agent_jobs').select('id, tenant_id, agent_name, status, created_at').eq('status', 'failed').gte('created_at', since)).order('created_at', { ascending: false }).limit(30),
      scoped(db.from('conversations').select('id, tenant_id, channel, direction, created_at').eq('direction', 'inbound').gte('created_at', since)).order('created_at', { ascending: false }).limit(30),
    ]);

    // Resolve tenant display names (cheap join via second select).
    const tenantIdSet = new Set();
    for (const r of [tenantsRes, leadsRes, contentRes, failuresRes, conversationsRes]) {
      for (const row of (r.data || [])) tenantIdSet.add(row.tenant_id || row.id);
    }
    const { data: tenantNames } = tenantIdSet.size
      ? await db.from('tenants').select('id, name').in('id', [...tenantIdSet])
      : { data: [] };
    const nameById = {};
    for (const t of tenantNames || []) nameById[t.id] = t.name;

    const events = [];
    for (const t of tenantsRes.data || []) {
      events.push({
        id: `tenant-${t.id}`,
        type: 'client_created',
        title: `New client onboarded`,
        detail: t.name,
        client: t.name,
        client_id: t.id,
        link: `/admin/clients`,
        status: t.status,
        timestamp: t.created_at,
      });
    }
    for (const l of leadsRes.data || []) {
      events.push({
        id: `lead-${l.id}`,
        type: 'lead_captured',
        title: 'Lead captured',
        detail: l.company_name || l.name || 'New lead',
        client: nameById[l.tenant_id] || 'FGA',
        client_id: l.tenant_id,
        // FGA leads open the pipeline detail; a client tenant's lead has no
        // FGA-pipeline page — it opens the client record instead.
        link: scope === 'fga' ? `/admin/pipeline/${l.id}` : '/admin/clients',
        status: l.lifecycle_stage,
        timestamp: l.created_at,
      });
    }
    for (const c of contentRes.data || []) {
      events.push({
        id: `content-${c.id}`,
        type: c.status === 'posted' ? 'content_posted' : 'content_created',
        title: c.status === 'posted' ? 'Content posted' : 'Content drafted',
        detail: c.headline || '(untitled)',
        client: nameById[c.tenant_id] || 'FGA',
        client_id: c.tenant_id,
        link: `/admin/content`,
        status: c.status,
        timestamp: c.created_at,
      });
    }
    for (const f of failuresRes.data || []) {
      events.push({
        id: `fail-${f.id}`,
        type: 'automation_failed',
        title: 'Automation failed',
        detail: f.agent_name,
        client: nameById[f.tenant_id] || 'FGA',
        client_id: f.tenant_id,
        link: `/admin/agent-hub`,
        status: 'failed',
        timestamp: f.created_at,
      });
    }
    for (const c of conversationsRes.data || []) {
      events.push({
        id: `conv-${c.id}`,
        type: c.channel === 'web_chat' ? 'web_chat_started' : c.channel === 'voice' ? 'voice_call' : 'reply_received',
        title:
          c.channel === 'web_chat'
            ? 'Web chat started'
            : c.channel === 'voice'
            ? 'Voice call received'
            : 'Reply received',
        detail: c.channel,
        client: nameById[c.tenant_id] || 'FGA',
        client_id: c.tenant_id,
        // Web chats deep-link with the OWNING tenant so the inbox that opens
        // actually contains the session ("Web chat started · 923A Coins" used
        // to link into the FGA-scoped inbox, which structurally could not
        // show it).
        link:
          c.channel === 'web_chat'
            ? (c.tenant_id === FGA_TENANT_ID ? '/admin/web-chats' : `/admin/web-chats?tenant=${c.tenant_id}`)
            : c.channel === 'voice'
            ? '/admin/voice'
            : (scope === 'fga' ? '/admin/pipeline?view=replied' : '/admin/clients'),
        status: 'new',
        timestamp: c.created_at,
      });
    }

    events.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
    res.json({ success: true, events: events.slice(0, limit) });
  } catch (err) {
    log.error(`Admin activity-feed failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
