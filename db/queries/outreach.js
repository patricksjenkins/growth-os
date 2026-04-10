/**
 * Outreach Campaign Queries
 */

const { db } = require('../client');

/**
 * Get campaigns with optional filters
 */
async function getCampaigns(tenantId, filters = {}) {
  let query = db
    .from('outreach_campaigns')
    .select('*, contact:contacts(name, email, company)')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false });

  if (filters.status) query = query.eq('status', filters.status);
  if (filters.campaign_type) query = query.eq('campaign_type', filters.campaign_type);
  if (filters.contact_id) query = query.eq('contact_id', filters.contact_id);
  if (filters.limit) query = query.limit(filters.limit);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

/**
 * Get single campaign with messages
 */
async function getCampaign(tenantId, campaignId) {
  const { data, error } = await db
    .from('outreach_campaigns')
    .select('*, contact:contacts(*), messages(*)')
    .eq('tenant_id', tenantId)
    .eq('id', campaignId)
    .single();
  if (error) throw error;
  return data;
}

/**
 * Create a campaign
 */
async function createCampaign(tenantId, data) {
  const { data: campaign, error } = await db
    .from('outreach_campaigns')
    .insert({
      tenant_id: tenantId,
      contact_id: data.contact_id,
      campaign_type: data.campaign_type || 'drip_email',
      status: 'active',
      current_step: 0,
      total_steps: data.total_steps || 7,
      next_send_at: data.next_send_at || new Date().toISOString(),
      metadata: data.metadata || {}
    })
    .select()
    .single();
  if (error) throw error;
  return campaign;
}

/**
 * Update campaign step (after sending)
 */
async function advanceCampaign(tenantId, campaignId, nextSendAt) {
  const { data, error } = await db
    .from('outreach_campaigns')
    .update({
      current_step: db.raw ? undefined : undefined, // handled below
      last_sent_at: new Date().toISOString(),
      next_send_at: nextSendAt,
      updated_at: new Date().toISOString()
    })
    .eq('tenant_id', tenantId)
    .eq('id', campaignId)
    .select()
    .single();

  // Increment step separately since Supabase JS doesn't support increment directly
  if (data) {
    await db
      .from('outreach_campaigns')
      .update({ current_step: data.current_step + 1 })
      .eq('id', campaignId);
  }

  if (error) throw error;
  return data;
}

/**
 * Complete a campaign
 */
async function completeCampaign(tenantId, campaignId) {
  const { data, error } = await db
    .from('outreach_campaigns')
    .update({
      status: 'completed',
      updated_at: new Date().toISOString()
    })
    .eq('tenant_id', tenantId)
    .eq('id', campaignId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

/**
 * Pause a campaign
 */
async function pauseCampaign(tenantId, campaignId) {
  const { data, error } = await db
    .from('outreach_campaigns')
    .update({ status: 'paused', updated_at: new Date().toISOString() })
    .eq('tenant_id', tenantId)
    .eq('id', campaignId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

/**
 * Get campaigns due to send (for drip agent)
 */
async function getDueCampaigns(tenantId) {
  const { data, error } = await db
    .from('outreach_campaigns')
    .select('*, contact:contacts(name, email, company)')
    .eq('tenant_id', tenantId)
    .eq('status', 'active')
    .lte('next_send_at', new Date().toISOString())
    .order('next_send_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

/**
 * Get campaign stats
 */
async function getCampaignStats(tenantId) {
  const { data, error } = await db
    .from('outreach_campaigns')
    .select('status, campaign_type')
    .eq('tenant_id', tenantId);
  if (error) throw error;

  const stats = { active: 0, paused: 0, completed: 0, failed: 0, total: 0 };
  for (const c of (data || [])) {
    stats[c.status] = (stats[c.status] || 0) + 1;
    stats.total++;
  }
  return stats;
}

module.exports = {
  getCampaigns,
  getCampaign,
  createCampaign,
  advanceCampaign,
  completeCampaign,
  pauseCampaign,
  getDueCampaigns,
  getCampaignStats
};
