/**
 * Growth OS — Clients Manager Agent (Tenant-Aware)
 * Ported from WellMor clients-agent.js
 *
 * Periodic maintenance: updates lead scores, cleans stale leads,
 * identifies leads that need attention, and generates a client
 * health summary.
 */

const { createLogger } = require('../../core/logger');
const { getConfig } = require('../../core/config');
const { db } = require('../../db/client');

/**
 * @param {Object} tenant - Resolved tenant
 * @param {Object} payload - {}
 */
async function run(tenant, payload = {}) {
  const log = createLogger('clients-manager', tenant.slug);

  const businessName = getConfig(tenant, 'business_name', tenant.name || 'Our Company');
  const staleDays = Number(getConfig(tenant, 'stale_lead_days', 14));

  // 1. Count leads by status
  const { data: statusCounts } = await db
    .from('leads')
    .select('status')
    .eq('tenant_id', tenant.id);

  const counts = {};
  for (const row of (statusCounts || [])) {
    counts[row.status] = (counts[row.status] || 0) + 1;
  }

  // 2. Find stale leads (no activity in X days)
  const staleDate = new Date(Date.now() - staleDays * 24 * 60 * 60 * 1000).toISOString();
  const { data: staleLeads } = await db
    .from('leads')
    .select('id, company_name, status, updated_at')
    .eq('tenant_id', tenant.id)
    .in('status', ['new_lead', 'contacted'])
    .lt('updated_at', staleDate)
    .limit(20);

  // 3. Mark stale leads
  if (staleLeads && staleLeads.length > 0) {
    const staleIds = staleLeads.map(l => l.id);
    await db
      .from('leads')
      .update({ lifecycle_stage: 'stale' })
      .in('id', staleIds)
      .eq('tenant_id', tenant.id);

    log.info(`Marked ${staleIds.length} leads as stale`);
  }

  // 4. Find hot leads (high score, recent activity)
  const { data: hotLeads } = await db
    .from('leads')
    .select('id, company_name, lead_score, status')
    .eq('tenant_id', tenant.id)
    .gte('lead_score', 70)
    .in('status', ['new_lead', 'contacted', 'demo_booked'])
    .order('lead_score', { ascending: false })
    .limit(10);

  // 5. Summary
  const summary = {
    total: Object.values(counts).reduce((s, c) => s + c, 0),
    by_status: counts,
    stale_marked: staleLeads?.length || 0,
    hot_leads: (hotLeads || []).map(l => ({ id: l.id, company: l.company_name, score: l.lead_score })),
  };

  // Log activity
  await db.from('activity_log').insert({
    tenant_id: tenant.id,
    agent: 'clients-manager',
    action: 'client_health_check',
    entity_type: 'system',
    metadata: summary,
  });

  log.success(`Client health check: ${summary.total} total, ${summary.stale_marked} stale, ${summary.hot_leads.length} hot`);
  return { success: true, ...summary };
}

module.exports = run;
