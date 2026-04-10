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
      notes: data.notes
    })
    .select()
    .single();
  if (error) throw error;
  return lead;
}

/**
 * Update a lead
 */
async function updateLead(tenantId, leadId, updates) {
  const { data, error } = await db
    .from('leads')
    .update({ ...updates, updated_at: new Date().toISOString() })
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

module.exports = {
  getLeads,
  getLead,
  createLead,
  updateLead,
  getLeadsByStatus,
  getPipelineStats
};
