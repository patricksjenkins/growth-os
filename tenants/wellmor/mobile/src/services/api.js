/**
 * WellMor API Service — Growth OS
 *
 * All API calls go through the authenticated `request()` helper which
 * attaches the current Supabase session JWT as a Bearer token.
 */

import { API_BASE_URL, ENDPOINTS } from '../constants/config';
import { getAccessToken } from './supabase';

// ============================================================================
// Core Request Helper
// ============================================================================

async function request(endpoint, options = {}) {
  const url = `${API_BASE_URL}${endpoint}`;
  const token = await getAccessToken();

  if (!token) {
    throw new Error('Not authenticated. Please log in again.');
  }

  try {
    const response = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...options.headers,
      },
      ...options,
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || `Request failed: ${response.status}`);
    }

    return data;
  } catch (error) {
    if (error.message === 'Network request failed') {
      throw new Error('Cannot reach server. Check your connection and API URL.');
    }
    throw error;
  }
}

// ============================================================================
// Dashboard
// ============================================================================

export async function fetchDashboard() {
  const data = await request(ENDPOINTS.dashboard);
  // Growth OS returns { success, stats: { content: {...}, leads: {...} } }
  // Mobile expects { dashboard: { pending_count, approved_count, posted_count, ... } }
  const stats = data.stats || {};
  const content = stats.content || {};
  const leads = stats.leads || {};

  return {
    dashboard: {
      pending_count: content.drafts || 0,
      approved_count: content.approved || 0,
      posted_count: content.posted || 0,
      pending_approvals: data.pending_approvals || [],
      recent_posts: data.recent_posts || [],
      total_clients: leads.total || 0,
      prospects: leads.new || 0,
      enriched: 0,
      sequenced: 0,
    },
  };
}

// ============================================================================
// Content Queue
// ============================================================================

export async function fetchDrafts() {
  const data = await request(ENDPOINTS.approvalsPending);
  // Growth OS returns { success, pending: [...], count }
  return { queue: (data.pending || []).map(normalizeDraft) };
}

export async function fetchApproved() {
  const data = await request(`${ENDPOINTS.contentList}?status=approved`);
  return { queue: (data.drafts || []).map(normalizeDraft) };
}

export async function fetchRejected() {
  const data = await request(`${ENDPOINTS.contentList}?status=rejected`);
  return { queue: (data.drafts || []).map(normalizeDraft) };
}

export async function fetchPosted() {
  const data = await request(ENDPOINTS.approvalsPosted);
  // Growth OS returns { success, posted: [...], count }
  return { queue: (data.posted || []).map(normalizeDraft) };
}

export async function fetchAllQueue() {
  const data = await request(ENDPOINTS.contentList);
  return { queue: (data.drafts || []).map(normalizeDraft) };
}

export async function fetchQueueItem(id) {
  const data = await request(`${ENDPOINTS.contentItem}/${id}`);
  // Growth OS returns { success, draft: {...} }
  return { item: normalizeDraft(data.draft) };
}

export async function fetchQueueSummary() {
  const data = await request(ENDPOINTS.dashboard);
  return data;
}

// ============================================================================
// Actions
// ============================================================================

export async function approvePost(id) {
  return request(`${ENDPOINTS.approve}/${id}/approve`, {
    method: 'POST',
  });
}

export async function rejectPost(id, reason) {
  return request(`${ENDPOINTS.reject}/${id}/reject`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

// ============================================================================
// Clients (mapped to Growth OS leads)
// ============================================================================

export async function fetchClients({ search, stage, tier, limit = 50, offset = 0 } = {}) {
  const params = new URLSearchParams();
  if (search) params.append('search', search);
  if (stage) params.append('status', stage);
  if (tier) params.append('tier', tier);
  params.append('limit', limit);
  const data = await request(`${ENDPOINTS.leadsList}?${params.toString()}`);
  // Growth OS returns { success, leads: [...], count }
  return { clients: (data.leads || []).map(normalizeLead) };
}

export async function fetchClientDetail(id) {
  const data = await request(`${ENDPOINTS.leadDetail}/${id}`);
  // Growth OS getLead returns lead with contacts via join
  const lead = data.lead || {};
  return {
    client: normalizeLead(lead),
    contacts: lead.contacts || [],
  };
}

export async function fetchClientStats() {
  const data = await request(ENDPOINTS.leadStats);
  // Growth OS returns { success, stats: { new_lead: N, contacted: N, ... } }
  const raw = data.stats || {};
  const total = Object.values(raw).reduce((sum, n) => sum + n, 0);
  return {
    stats: {
      total,
      by_stage: {
        prospect: raw.new_lead || 0,
        enriched: raw.contacted || 0,
        sequenced: raw.quoted || 0,
      },
      by_tier: {},
    },
  };
}

// ============================================================================
// Health
// ============================================================================

export async function checkHealth() {
  const url = `${API_BASE_URL}${ENDPOINTS.health}`;
  const response = await fetch(url);
  return response.json();
}

// ============================================================================
// Image URL Helper
// ============================================================================

export function getImageUrl(fileName) {
  if (!fileName) return null;
  return `${API_BASE_URL}${ENDPOINTS.images}/${fileName}`;
}

// ============================================================================
// Normalizers — map Growth OS field names to what screens expect
// ============================================================================

/**
 * Normalize a content_drafts row from Growth OS into the shape the mobile
 * screens expect. Growth OS stores rich metadata in campaign_payload;
 * the mobile screens expect some of those as top-level fields.
 */
function normalizeDraft(draft) {
  if (!draft) return draft;
  const payload = draft.campaign_payload || {};
  const content = payload.content || {};

  return {
    ...draft,
    // Fields the screens read as top-level that may live in campaign_payload
    post_copy: draft.body || payload.post_copy || '',
    hook: payload.hook || content.hook || '',
    subtext: payload.subtext || '',
    best_time: payload.best_time || '',
    goal: payload.goal || '',
    cta: payload.cta || content.cta || '',
    // Image: Growth OS uses image_urls array, old app used image_file_name
    image_file_name: extractImageFileName(draft),
    // Ensure campaign_payload is available for carousel rendering
    campaign_payload: payload,
  };
}

/**
 * Extract a single image file name from the Growth OS draft.
 * Prefers the first carousel image, then falls back to image_urls[0].
 */
function extractImageFileName(draft) {
  const payload = draft.campaign_payload || {};
  const carouselImages = payload.carousel_images || [];

  if (carouselImages.length > 0 && carouselImages[0].file_name) {
    return carouselImages[0].file_name;
  }

  if (draft.image_urls && draft.image_urls.length > 0) {
    const url = draft.image_urls[0];
    // If it's a full URL, extract just the filename
    const parts = url.split('/');
    return parts[parts.length - 1];
  }

  return null;
}

/**
 * Normalize a Growth OS lead into the "client" shape the mobile screens expect.
 */
function normalizeLead(lead) {
  if (!lead) return lead;
  return {
    ...lead,
    company: lead.company_name || lead.name || 'Unknown',
    industry: lead.service_type || '',
    lifecycle_stage: mapLeadStatus(lead.status),
    lead_tier: lead.priority_tier || null,
    lead_score: lead.lead_score || 0,
    hq_city: lead.city || '',
    hq_state: '',
    employee_count_actual: null,
    size: null,
    source: lead.lead_source || '',
    morgan_notes: lead.notes || '',
    domain: null,
    website: null,
    enrichment_status: null,
    outreach_ready: false,
    outreach_recommendation: null,
  };
}

/**
 * Map Growth OS lead statuses to the lifecycle stages the mobile UI expects.
 */
function mapLeadStatus(status) {
  const map = {
    new_lead: 'prospect',
    contacted: 'enriched',
    quoted: 'sequenced',
    won: 'meeting_booked',
    lost: 'prospect',
  };
  return map[status] || 'prospect';
}
