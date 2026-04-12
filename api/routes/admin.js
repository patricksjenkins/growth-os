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

const FGA_TENANT_ID = '30566ed6-026a-45e1-9502-029e6219df31';

const TIER_PRICING = {
  growth: 497,
  scale: 997
};

// ---------------------------------------------------------------------------
// GET /api/admin/overview — Cross-tenant business overview
// ---------------------------------------------------------------------------
router.get('/overview', async (req, res) => {
  try {
    const db = getServiceClient();

    // Fetch all active tenants
    const { data: tenants, error: tenantErr } = await db
      .from('tenants')
      .select('id, name, slug, vertical, status, created_at')
      .eq('status', 'active');

    if (tenantErr) throw tenantErr;

    const tenantIds = (tenants || []).map(t => t.id);

    // Parallel counts across all tenants
    const [leadsRes, contentRes, configRes] = await Promise.all([
      db.from('leads').select('tenant_id').in('tenant_id', tenantIds),
      db.from('content_drafts').select('tenant_id, status').in('tenant_id', tenantIds),
      db.from('tenant_config').select('tenant_id, key, value').eq('key', 'tier').in('tenant_id', tenantIds)
    ]);

    // Build per-tenant stats
    const tenantStats = (tenants || []).map(tenant => {
      const leadCount = (leadsRes.data || []).filter(l => l.tenant_id === tenant.id).length;
      const tenantContent = (contentRes.data || []).filter(c => c.tenant_id === tenant.id);
      const tierConfig = (configRes.data || []).find(c => c.tenant_id === tenant.id);

      return {
        ...tenant,
        tier: tierConfig?.value || 'growth',
        lead_count: leadCount,
        content_count: tenantContent.length,
        content_by_status: {
          draft: tenantContent.filter(c => c.status === 'draft').length,
          approved: tenantContent.filter(c => c.status === 'approved').length,
          posted: tenantContent.filter(c => c.status === 'posted').length
        }
      };
    });

    // Calculate MRR from tier counts
    const tierCounts = { growth: 0, scale: 0 };
    for (const t of tenantStats) {
      const tier = t.tier || 'growth';
      tierCounts[tier] = (tierCounts[tier] || 0) + 1;
    }
    const mrr = (tierCounts.growth * TIER_PRICING.growth) +
                (tierCounts.scale * TIER_PRICING.scale);

    res.json({
      success: true,
      tenants: tenantStats,
      totals: {
        total_tenants: (tenants || []).length,
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
// GET /api/admin/finance — Financial overview (MRR, ARR, by tier)
// ---------------------------------------------------------------------------
router.get('/finance', async (req, res) => {
  try {
    const db = getServiceClient();

    // Tenant counts by tier
    const { data: configs, error: configErr } = await db
      .from('tenant_config')
      .select('tenant_id, value')
      .eq('key', 'tier');

    if (configErr) throw configErr;

    // Only count active tenants
    const { data: activeTenants, error: activeErr } = await db
      .from('tenants')
      .select('id')
      .eq('status', 'active');

    if (activeErr) throw activeErr;

    const activeIds = new Set((activeTenants || []).map(t => t.id));
    const activeConfigs = (configs || []).filter(c => activeIds.has(c.tenant_id));

    const byTier = { growth: 0, scale: 0 };
    for (const c of activeConfigs) {
      const tier = c.value || 'growth';
      byTier[tier] = (byTier[tier] || 0) + 1;
    }

    const mrr = (byTier.growth * TIER_PRICING.growth) +
                (byTier.scale * TIER_PRICING.scale);
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
      tenant_count: activeIds.size,
      by_tier: byTier,
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
