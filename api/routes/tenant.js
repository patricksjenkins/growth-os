/**
 * Growth OS — Tenant Self-View Routes
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
const { createLogger } = require('../../core/logger');
const log = createLogger('tenant-api');

// ---------------------------------------------------------------------------
// GET /api/tenant/overview — Single-tenant business overview
// Matches /api/admin/overview shape so the mobile Overview screen works as-is:
//   { success, tenants: [SELF], totals: {...} }
// ---------------------------------------------------------------------------
router.get('/overview', async (req, res) => {
  try {
    const db = getServiceClient();
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

    // Pipeline buckets
    const openLeads = leads.filter((l) => !['completed', 'lost', 'won'].includes(l.status)).length;
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
    const db = getServiceClient();

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
    const db = getServiceClient();
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
    const db = getServiceClient();
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
    const db = getServiceClient();
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
// GET /api/tenant/clients — THIS tenant's end-customers (NOT sub-tenants)
// Matches /api/admin/clients shape so the Accounts screen renders with no change.
// Source: contacts table filtered to contact_type='customer' + completed jobs.
// ---------------------------------------------------------------------------
router.get('/clients', async (req, res) => {
  try {
    const db = getServiceClient();

    // Customers = contacts tied to this tenant with contact_type='customer'
    // or with a lead_id pointing to a won/completed lead.
    const { data: contacts, error: contactErr } = await db
      .from('contacts')
      .select('id, lead_id, name, email, phone, contact_type, outreach_status, created_at')
      .eq('tenant_id', req.tenantId)
      .in('contact_type', ['customer', 'lead', null]);

    if (contactErr) throw contactErr;

    // Pull the leads those contacts point to so we can compute health / last activity
    const leadIds = [...new Set((contacts || []).map((c) => c.lead_id).filter(Boolean))];
    const { data: leads } = leadIds.length
      ? await db
          .from('leads')
          .select('id, status, final_revenue, service_type, city, updated_at')
          .in('id', leadIds)
      : { data: [] };

    const leadMap = {};
    for (const l of leads || []) leadMap[l.id] = l;

    const clients = (contacts || [])
      .filter((c) => c.contact_type === 'customer' || (c.lead_id && leadMap[c.lead_id]))
      .map((c) => {
        const lead = c.lead_id ? leadMap[c.lead_id] : null;
        const lastActivity = lead?.updated_at || c.created_at;
        let health = 'yellow';
        if (lastActivity) {
          const days = (Date.now() - new Date(lastActivity).getTime()) / (1000 * 60 * 60 * 24);
          if (days <= 30) health = 'green';
          else if (days <= 90) health = 'yellow';
          else health = 'red';
        }
        return {
          id: c.id,
          name: c.name,
          email: c.email,
          phone: c.phone,
          contact_type: c.contact_type,
          service_type: lead?.service_type || null,
          city: lead?.city || null,
          lifetime_revenue: parseFloat(lead?.final_revenue || 0),
          last_status: lead?.status || null,
          last_activity: lastActivity,
          health,
          // Mirrors the admin clients shape so the mobile screen reuses the
          // same keys without branching.
          tier: 'customer',
          business_name: c.name,
          lead_count: c.lead_id ? 1 : 0,
          content_count: 0,
        };
      });

    res.json({ success: true, clients });
  } catch (err) {
    log.error(`Tenant clients failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/tenant/clients/:customerId — Single customer detail
router.get('/clients/:customerId', async (req, res) => {
  try {
    const db = getServiceClient();
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
    const db = getServiceClient();
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
    const db = getServiceClient();
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

// GET /api/tenant/self — Who am I? Used by the mobile app on login to
// resolve role + tenant info without a separate Supabase roundtrip.
router.get('/self', async (req, res) => {
  res.json({
    success: true,
    tenant: req.tenant,
    is_demo: req.isDemo,
  });
});

module.exports = router;
