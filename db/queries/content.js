/**
 * Content Pipeline Queries
 */

const { db } = require('../client');

/**
 * Create a content draft
 */
async function createDraft(tenantId, data) {
  const { data: draft, error } = await db
    .from('content_drafts')
    .insert({
      tenant_id: tenantId,
      content_type: data.content_type || 'carousel',
      platform: data.platform || 'linkedin',
      status: 'draft',
      headline: data.headline,
      body: data.body,
      hashtags: data.hashtags,
      image_urls: data.image_urls,
      campaign_payload: data.campaign_payload,
      format_template: data.format_template,
      topic: data.topic
    })
    .select()
    .single();
  if (error) throw error;
  return draft;
}

/**
 * Get drafts with optional filters
 */
async function getDrafts(tenantId, filters = {}) {
  let query = db
    .from('content_drafts')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false });

  if (filters.status) query = query.eq('status', filters.status);
  if (filters.platform) query = query.eq('platform', filters.platform);
  if (filters.limit) query = query.limit(filters.limit);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

/**
 * Get single draft by ID
 */
async function getDraft(tenantId, draftId) {
  const { data, error } = await db
    .from('content_drafts')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('id', draftId)
    .single();
  if (error) throw error;
  return data;
}

/**
 * Approve a draft (with race condition protection)
 */
async function approveDraft(tenantId, draftId, userId) {
  const { data, error } = await db
    .from('content_drafts')
    .update({
      status: 'approved',
      approved_by: userId,
      updated_at: new Date().toISOString()
    })
    .eq('tenant_id', tenantId)
    .eq('id', draftId)
    .eq('status', 'draft') // Only approve if still a draft
    .select()
    .single();
  if (error) throw error;
  return data;
}

/**
 * Reject a draft
 */
async function rejectDraft(tenantId, draftId, userId, reason) {
  const { data, error } = await db
    .from('content_drafts')
    .update({
      status: 'rejected',
      approved_by: userId,
      rejected_reason: reason,
      updated_at: new Date().toISOString()
    })
    .eq('tenant_id', tenantId)
    .eq('id', draftId)
    .eq('status', 'draft')
    .select()
    .single();
  if (error) throw error;
  return data;
}

/**
 * Mark a draft as posted
 */
async function markPosted(tenantId, draftId, bufferPostId) {
  const { data, error } = await db
    .from('content_drafts')
    .update({
      status: 'posted',
      buffer_post_id: bufferPostId,
      posted_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq('tenant_id', tenantId)
    .eq('id', draftId)
    .eq('status', 'approved') // Only post if approved
    .select()
    .single();
  if (error) throw error;
  return data;
}

/**
 * Get approved but not yet published drafts
 */
async function getApprovedUnpublished(tenantId) {
  const { data, error } = await db
    .from('content_drafts')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('status', 'approved')
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

module.exports = {
  createDraft,
  getDrafts,
  getDraft,
  approveDraft,
  rejectDraft,
  markPosted,
  getApprovedUnpublished
};
