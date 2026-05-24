/**
 * Lead Queries
 */

const { db } = require('../client');

/**
 * Get leads with optional filters
 */
async function getLeads(tenantId, filters = {}) {
  let query = db
    .from('leads')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false });

  if (filters.status) query = query.eq('status', filters.status);
  if (filters.lead_source) query = query.eq('lead_source', filters.lead_source);
  if (filters.priority_tier) query = query.eq('priority_tier', filters.priority_tier);
  if (filters.search) query = query.or(`name.ilike.%${filters.search}%,company_name.ilike.%${filters.search}%,email.ilike.%${filters.search}%`);
  if (filters.limit) query = query.limit(filters.limit);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

/**
 * Get single lead with contacts
 */
async function getLead(tenantId, leadId) {
  const { data, error } = await db
    .from('leads')
    .select('*, contacts(*)')
    .eq('tenant_id', tenantId)
    .eq('id', leadId)
    .single();
  if (error) throw error;
  return data;
}

/**
 * Create a new lead
 */
async function createLead(tenantId, data) {
  const { data: lead, error } = await db
    .from('leads')
    .insert({
      tenant_id: tenantId,
      name: data.name,
      phone: data.phone,
      email: data.email,
      company_name: data.company_name,
      service_type: data.service_type,
      lead_source: data.lead_source,
      status: data.status || 'new_lead',
      address: data.address,
      city: data.city,
      notes: data.notes,
      // Intelligence fields
      industry: data.industry || null,
      size: data.size || null,
      website: data.website || null,
      domain: data.domain || null,
      lifecycle_stage: data.lifecycle_stage || 'prospect',
      enrichment_status: data.enrichment_status || null,
      employee_count_actual: data.employee_count_actual || null,
      hq_state: data.hq_state || null,
      metadata: data.metadata || {}
    })
    .select()
    .single();
  if (error) throw error;
  return lead;
}

// V1 hardening (2026-05-24): DB-layer column allowlist. Even if a route
// handler skips its own filter, this drops disallowed keys before UPDATE.
// Notably blocks tenant_id swap and id rebinding via mass-assignment.
const LEAD_UPDATABLE = [
  'name', 'company_name', 'email', 'phone', 'status', 'lead_source',
  'priority_tier', 'lead_score', 'lifecycle_stage', 'final_revenue',
  'service_type', 'city', 'hq_state', 'estimate_amount', 'notes',
  'metadata', 'contact_id', 'last_contacted_at',
];
function pickLeadUpdates(updates) {
  if (!updates || typeof updates !== 'object') return {};
  const out = {};
  for (const key of LEAD_UPDATABLE) {
    if (updates[key] !== undefined) out[key] = updates[key];
  }
  return out;
}

/**
 * Update a lead
 */
async function updateLead(tenantId, leadId, updates) {
  const safe = pickLeadUpdates(updates);
  const { data, error } = await db
    .from('leads')
    .update({ ...safe, updated_at: new Date().toISOString() })
    .eq('tenant_id', tenantId)
    .eq('id', leadId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

/**
 * Get leads by status (for agents)
 */
async function getLeadsByStatus(tenantId, status) {
  const { data, error } = await db
    .from('leads')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('status', status)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

/**
 * Get pipeline stats
 */
async function getPipelineStats(tenantId) {
  const { data, error } = await db
    .from('leads')
    .select('status')
    .eq('tenant_id', tenantId);
  if (error) throw error;

  const stats = {};
  for (const lead of (data || [])) {
    stats[lead.status] = (stats[lead.status] || 0) + 1;
  }
  return stats;
}

/**
 * Get intelligence stats (scoring, lifecycle, enrichment)
 */
async function getIntelligenceStats(tenantId) {
  const { data, error } = await db
    .from('leads')
    .select('priority_tier, lifecycle_stage, enrichment_status, outreach_ready, lead_score')
    .eq('tenant_id', tenantId);
  if (error) throw error;

  const leads = data || [];

  return {
    total: leads.length,
    by_tier: leads.reduce((acc, l) => {
      const tier = l.priority_tier || 'unscored';
      acc[tier] = (acc[tier] || 0) + 1;
      return acc;
    }, {}),
    by_lifecycle: leads.reduce((acc, l) => {
      const stage = l.lifecycle_stage || 'unknown';
      acc[stage] = (acc[stage] || 0) + 1;
      return acc;
    }, {}),
    by_enrichment: leads.reduce((acc, l) => {
      const status = l.enrichment_status || 'none';
      acc[status] = (acc[status] || 0) + 1;
      return acc;
    }, {}),
    outreach_ready: leads.filter(l => l.outreach_ready).length,
    avg_score: leads.filter(l => l.lead_score != null).length > 0
      ? Math.round(leads.filter(l => l.lead_score != null).reduce((sum, l) => sum + l.lead_score, 0) / leads.filter(l => l.lead_score != null).length)
      : null
  };
}

/**
 * Get leads by lifecycle stage
 */
async function getLeadsByLifecycle(tenantId, stage) {
  const { data, error } = await db
    .from('leads')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('lifecycle_stage', stage)
    .order('lead_score', { ascending: false, nullsFirst: false });
  if (error) throw error;
  return data || [];
}

/**
 * Get outreach-ready leads (Tier A, scored, ready to go)
 */
async function getOutreachReady(tenantId) {
  const { data, error } = await db
    .from('leads')
    .select('*, contacts(*)')
    .eq('tenant_id', tenantId)
    .eq('outreach_ready', true)
    .order('lead_score', { ascending: false });
  if (error) throw error;
  return data || [];
}

module.exports = {
  getLeads,
  getLead,
  createLead,
  updateLead,
  getLeadsByStatus,
  getPipelineStats,
  getIntelligenceStats,
  getLeadsByLifecycle,
  getOutreachReady
};
