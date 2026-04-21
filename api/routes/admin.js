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

// FGA tenant id — env-driven with a fallback to the known production UUID so
// local dev and existing deployments don't break if the env var is missing.
const FGA_TENANT_ID = process.env.FGA_TENANT_ID || '30566ed6-026a-45e1-9502-029e6219df31';

const TIER_PRICING = {
  growth: 497,
  scale: 997
};

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

    const tenants = (allTenants || []).filter(t => !t.is_demo);
    const demoTenants = (allTenants || []).filter(t => t.is_demo);
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
      const monthlyRate = rateConfig ? parseFloat(rateConfig.value) : TIER_PRICING[tier] || TIER_PRICING.growth;

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

    res.json({
      success: true,
      tenants: tenantStats,
      demo_tenants: demoTenants,
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

    // Group by status
    const pipeline = {};
    for (const lead of (leads || [])) {
      const status = lead.status || 'new_lead';
      pipeline[status] = (pipeline[status] || 0) + 1;
    }

    res.json({
      success: true,
      pipeline,
      leads: leads || []
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
    const { tier, status, business_name, vertical, monthly_rate, setup_fee, setup_fee_paid, modules } = req.body;

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
      .in('key', ['tier', 'monthly_rate', 'setup_fee', 'setup_fee_paid', 'business_name'])
      .in('tenant_id', tenantIds);

    if (configErr) throw configErr;

    // Build per-tenant config map
    const configMap = {};
    for (const c of (configs || [])) {
      if (!configMap[c.tenant_id]) configMap[c.tenant_id] = {};
      configMap[c.tenant_id][c.key] = c.value;
    }

    // Build per-client breakdown
    const clients = [];
    let mrr = 0;
    let totalSetupFees = 0;
    let setupFeesPaid = 0;
    const byTier = { growth: 0, scale: 0 };

    for (const tenant of (allTenants || [])) {
      const cfg = configMap[tenant.id] || {};
      const tier = cfg.tier || 'growth';
      const customRate = cfg.monthly_rate ? parseFloat(cfg.monthly_rate) : null;
      const monthlyRate = customRate !== null ? customRate : TIER_PRICING[tier] || TIER_PRICING.growth;
      const setupFee = cfg.setup_fee ? parseFloat(cfg.setup_fee) : 2000;
      const setupFeePaid = cfg.setup_fee_paid === 'true' || cfg.setup_fee_paid === true;

      const clientEntry = {
        id: tenant.id,
        name: cfg.business_name || tenant.name,
        status: tenant.status,
        tier,
        monthly_rate: monthlyRate,
        custom_rate: customRate !== null,
        setup_fee: setupFee,
        setup_fee_paid: setupFeePaid,
      };

      clients.push(clientEntry);

      // Only count active tenants toward MRR
      if (tenant.status === 'active') {
        mrr += monthlyRate;
        byTier[tier] = (byTier[tier] || 0) + 1;
      }

      totalSetupFees += setupFee;
      if (setupFeePaid) setupFeesPaid += setupFee;
    }

    const arr = mrr * 12;

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
      tenant_count: byTier.growth + byTier.scale,
      by_tier: byTier,
      clients,
      setup_fees: { total: totalSetupFees, paid: setupFeesPaid, outstanding: totalSetupFees - setupFeesPaid },
      revenue_history: revenueHistory
    });
  } catch (err) {
    log.error(`Admin finance failed: ${err.message}`);
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

module.exports = router;
