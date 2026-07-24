/**
 * Tenant-safe Document Center read API.
 *
 * The route is hidden unless FGA_OS_DOCUMENT_CENTER_API_ENABLED=true. It uses
 * the caller's JWT-bound Supabase client so migration 069's role,
 * classification, explicit-grant, and tenant policies remain authoritative.
 * There are intentionally no mutation or signed-download endpoints yet.
 */

'use strict';

const express = require('express');
const { getUserClient } = require('../../db/userClient');
const { createLogger } = require('../../core/logger');
const { flags } = require('../../core/autonomous-os/feature-flags');
const { tenantInCohort } = require('../../core/autonomous-os/cohort');
const { hasDocumentCenterRole } = require('../../core/authz/roles');

const router = express.Router();
const log = createLogger('document-center-routes');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATUSES = new Set(['draft', 'in_review', 'approved', 'published', 'retired']);
const CLASSIFICATIONS = new Set(['public', 'client', 'internal', 'restricted']);

function enumFilter(value, allowed) {
  if (value == null || value === '') return null;
  const normalized = String(value).trim().toLowerCase();
  return allowed.has(normalized) ? normalized : false;
}

function parseDocumentFilters(query = {}) {
  const status = enumFilter(query.status, STATUSES);
  const classification = enumFilter(query.classification, CLASSIFICATIONS);
  const limitNumber = Number(query.limit);
  const limit = Number.isFinite(limitNumber)
    ? Math.max(1, Math.min(Math.trunc(limitNumber), 100))
    : 50;
  const errors = [];
  if (status === false) errors.push('invalid_status');
  if (classification === false) errors.push('invalid_classification');
  return {
    valid: errors.length === 0,
    errors,
    value: {
      status: status || null,
      classification: classification || null,
      documentType: typeof query.document_type === 'string'
        ? query.document_type.trim().slice(0, 80)
        : '',
      tag: typeof query.tag === 'string' ? query.tag.trim().toLowerCase().slice(0, 50) : '',
      includeRetired: query.include_retired === 'true',
      limit,
    },
  };
}

function requireDocumentCenter(req, res, next) {
  if (
    !flags.documentCenterApi() ||
    !tenantInCohort(req.tenantId, 'FGA_OS_DOCUMENT_CENTER_TENANT_ALLOWLIST')
  ) {
    return res.status(404).json({ success: false, error: 'Not found' });
  }
  const currentRole = req.user?.app_metadata?.role;
  const currentTenant = req.user?.app_metadata?.tenant_id;
  if (!hasDocumentCenterRole(currentRole) || currentTenant !== req.tenantId) {
    return res.status(403).json({
      success: false,
      error: 'Current tenant document access could not be verified',
    });
  }
  next();
}

router.use(requireDocumentCenter);

router.get('/search', async (req, res) => {
  const search = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 200) : '';
  const limitNumber = Number(req.query.limit);
  const limit = Number.isFinite(limitNumber)
    ? Math.max(1, Math.min(Math.trunc(limitNumber), 50))
    : 20;
  if (search.length < 2) {
    return res.status(400).json({ success: false, error: 'Search requires at least 2 characters' });
  }

  try {
    const db = getUserClient(req);
    const { data, error } = await db
      .from('document_chunks')
      .select(
        'tenant_id, document_id, version_id, chunk_index, content, page_number, ' +
        'section_label, citation_anchor'
      )
      .eq('tenant_id', req.tenantId)
      .textSearch('search_vector', search, { type: 'websearch', config: 'english' })
      .limit(limit);
    if (error) throw error;
    return res.json({
      success: true,
      query: search,
      results: (data || []).map(row => ({
        document_id: row.document_id,
        version_id: row.version_id,
        excerpt: row.content.slice(0, 600),
        citation: {
          anchor: row.citation_anchor,
          chunk_index: row.chunk_index,
          page_number: row.page_number,
          section_label: row.section_label,
        },
        tenant_id: row.tenant_id,
      })),
    });
  } catch (error) {
    log.error('Search failed', error);
    return res.status(500).json({ success: false, error: 'Unable to search documents' });
  }
});

router.get('/', async (req, res) => {
  const parsed = parseDocumentFilters(req.query);
  if (!parsed.valid) {
    return res.status(400).json({ success: false, error: 'Invalid filters', codes: parsed.errors });
  }
  try {
    const db = getUserClient(req);
    const filter = parsed.value;
    let query = db
      .from('documents')
      .select(
        'id, tenant_id, title, document_type, lifecycle_status, classification, ' +
        'owner_type, owner_id, source_provider, current_version_number, tags, ' +
        'effective_at, review_due_at, approved_at, published_at, retired_at, ' +
        'created_at, updated_at'
      )
      .eq('tenant_id', req.tenantId)
      .is('deleted_at', null);
    if (filter.status) query = query.eq('lifecycle_status', filter.status);
    if (filter.classification) query = query.eq('classification', filter.classification);
    if (filter.documentType) query = query.eq('document_type', filter.documentType);
    if (filter.tag) query = query.contains('tags', [filter.tag]);
    if (!filter.includeRetired && !filter.status) {
      query = query.neq('lifecycle_status', 'retired');
    }
    const { data, error } = await query
      .order('updated_at', { ascending: false })
      .limit(filter.limit);
    if (error) throw error;
    return res.json({
      success: true,
      documents: data || [],
      page: { limit: filter.limit, returned: data?.length || 0 },
    });
  } catch (error) {
    log.error('List failed', error);
    return res.status(500).json({ success: false, error: 'Unable to load documents' });
  }
});

router.get('/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    return res.status(400).json({ success: false, error: 'Invalid document id' });
  }
  try {
    const db = getUserClient(req);
    const [documentResult, versionsResult, linksResult, eventsResult] = await Promise.all([
      db
        .from('documents')
        .select(
          'id, tenant_id, title, document_type, lifecycle_status, classification, ' +
          'owner_type, owner_id, source_provider, source_external_id, current_version_number, ' +
          'tags, effective_at, review_due_at, approved_at, published_at, retired_at, ' +
          'created_by, updated_by, created_at, updated_at'
        )
        .eq('tenant_id', req.tenantId)
        .eq('id', req.params.id)
        .is('deleted_at', null)
        .maybeSingle(),
      db
        .from('document_versions')
        .select(
          'id, tenant_id, document_id, version_number, original_filename, mime_type, ' +
          'byte_size, sha256, change_summary, ingestion_status, malware_scan_status, ' +
          'extracted_text_status, created_by, created_at'
        )
        .eq('tenant_id', req.tenantId)
        .eq('document_id', req.params.id)
        .order('version_number', { ascending: false })
        .limit(100),
      db
        .from('document_links')
        .select('id, tenant_id, document_id, entity_type, entity_id, relationship, created_at')
        .eq('tenant_id', req.tenantId)
        .eq('document_id', req.params.id)
        .limit(200),
      db
        .from('document_events')
        .select(
          'id, tenant_id, document_id, version_id, event_type, actor_type, actor_id, ' +
          'previous_state, next_state, reason, correlation_id, created_at'
        )
        .eq('tenant_id', req.tenantId)
        .eq('document_id', req.params.id)
        .order('created_at', { ascending: true })
        .limit(200),
    ]);
    for (const result of [documentResult, versionsResult, linksResult, eventsResult]) {
      if (result.error) throw result.error;
    }
    if (!documentResult.data) {
      return res.status(404).json({ success: false, error: 'Not found' });
    }
    return res.json({
      success: true,
      document: documentResult.data,
      versions: versionsResult.data || [],
      links: linksResult.data || [],
      events: eventsResult.data || [],
    });
  } catch (error) {
    log.error('Detail failed', error);
    return res.status(500).json({ success: false, error: 'Unable to load document' });
  }
});

module.exports = router;
module.exports._internal = {
  parseDocumentFilters,
  requireDocumentCenter,
};
