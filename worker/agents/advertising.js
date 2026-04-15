/**
 * Growth OS — Advertising Agent (Tenant-Aware)
 * Ported from WellMor advertising-agent.js
 *
 * Weekly advertising performance analysis. Calculates ROI, CPL,
 * and generates strategic recommendations via Claude.
 */

const { askClaudeJSON } = require('../../integrations/claude');
const { createLogger } = require('../../core/logger');
const { getConfig } = require('../../core/config');
const { db } = require('../../db/client');

/**
 * @param {Object} tenant - Resolved tenant
 * @param {Object} payload - { days }
 */
async function run(tenant, payload = {}) {
  const log = createLogger('advertising', tenant.slug);
  const startTime = Date.now();

  const businessName = getConfig(tenant, 'business_name', tenant.name || 'Our Company');
  const days = Number(payload.days || 30);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  // Fetch performance data
  const { data: perfData, error: perfErr } = await db
    .from('marketing_performance')
    .select('*')
    .eq('tenant_id', tenant.id)
    .gte('date', cutoff)
    .order('date', { ascending: false });

  if (perfErr) throw perfErr;

  if (!perfData || !perfData.length) {
    log.info('No advertising data available');
    return { success: true, message: 'No advertising data', duration_ms: Date.now() - startTime };
  }

  // Group by channel
  const byChannel = {};
  for (const row of perfData) {
    if (!byChannel[row.channel]) byChannel[row.channel] = [];
    byChannel[row.channel].push(row);
  }

  // Fetch lead attribution
  const { data: leads } = await db
    .from('leads')
    .select('lead_source')
    .eq('tenant_id', tenant.id)
    .gte('created_at', new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString());

  const leadCounts = {};
  for (const lead of (leads || [])) {
    if (lead.lead_source) leadCounts[lead.lead_source] = (leadCounts[lead.lead_source] || 0) + 1;
  }

  // Calculate metrics per channel
  const metrics = {};
  for (const [channel, rows] of Object.entries(byChannel)) {
    const totalSpend = rows.reduce((s, r) => s + (r.spend || 0), 0);
    const totalClicks = rows.reduce((s, r) => s + (r.clicks || 0), 0);
    const totalImpressions = rows.reduce((s, r) => s + (r.impressions || 0), 0);
    const channelLeads = leadCounts[channel] || 0;

    metrics[channel] = {
      spend: parseFloat(totalSpend.toFixed(2)),
      clicks: totalClicks,
      impressions: totalImpressions,
      leads: channelLeads,
      cpl: channelLeads > 0 ? parseFloat((totalSpend / channelLeads).toFixed(2)) : 0,
      ctr: totalImpressions > 0 ? parseFloat(((totalClicks / totalImpressions) * 100).toFixed(2)) : 0,
    };
  }

  // Generate analysis via Claude
  const metricsSummary = Object.entries(metrics).map(([ch, d]) =>
    `${ch}: Spend $${d.spend}, Leads ${d.leads}, CPL $${d.cpl}, CTR ${d.ctr}%`
  ).join('\n');

  const report = await askClaudeJSON(
    `You are a digital marketing analyst for ${businessName}. Analyze ad performance and recommend improvements.`,
    `Analyze this ${days}-day performance:\n\n${metricsSummary}\n\nReturn JSON: { "executive_summary": "string", "top_recommendations": [{ "title": "string", "description": "string", "expected_impact": "string" }], "budget_recommendation": { "rationale": "string" }, "critical_alerts": ["string"] }`,
    { maxTokens: 2000, tenantSlug: tenant.slug }
  );

  // Store report
  await db.from('marketing_performance_reports').insert({
    tenant_id: tenant.id,
    report_data: report,
    metrics,
    period_days: days,
  });

  // Log activity
  await db.from('activity_log').insert({
    tenant_id: tenant.id,
    agent: 'advertising',
    action: 'ad_analysis_generated',
    entity_type: 'system',
    metadata: { channels: Object.keys(metrics).length, period_days: days },
  });

  const duration = Date.now() - startTime;
  log.success(`Ad analysis complete: ${Object.keys(metrics).length} channels`, { duration });

  return {
    success: true,
    channels_analyzed: Object.keys(metrics).length,
    metrics,
    top_recommendation: report.top_recommendations?.[0]?.title,
    critical_alerts: report.critical_alerts || [],
    duration_ms: duration,
  };
}

module.exports = run;
