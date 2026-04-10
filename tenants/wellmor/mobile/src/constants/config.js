/**
 * App configuration — Growth OS API
 *
 * API_BASE_URL is set via EXPO_PUBLIC_API_URL env var (for Railway production).
 * Falls back to localhost for local development.
 *
 * All /api/* endpoints require a Supabase JWT Bearer token.
 */

export const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:3001';

export const ENDPOINTS = {
  // Health (no auth)
  health: '/health',

  // Dashboard (aggregated stats + recent items)
  dashboard: '/api/dashboard',

  // Content drafts
  contentList: '/api/content',
  contentItem: '/api/content',           // + /:id
  contentGenerate: '/api/content/generate',

  // Approvals (mobile-optimized)
  approvalsPending: '/api/approvals/pending',
  approvalsPosted: '/api/approvals/posted',
  approve: '/api/approvals',             // + /:id/approve
  reject: '/api/approvals',              // + /:id/reject

  // Leads (displayed as "Clients" in WellMor mobile)
  leadsList: '/api/leads',
  leadDetail: '/api/leads',              // + /:id
  leadStats: '/api/leads/stats',

  // Tenant config
  config: '/api/config',

  // Static images served by API
  images: '/images',
};
