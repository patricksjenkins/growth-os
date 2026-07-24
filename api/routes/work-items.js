/**
 * Canonical tenant work-item control plane.
 *
 * This first route slice is deliberately read-only. The entire surface is
 * hidden unless FGA_OS_CONTROL_PLANE_API_ENABLED=true, and database mutation
 * remains separately gated and transactional in the next migration/API slice.
 */

'use strict';

const express = require('express');
const { getUserClient } = require('../../db/userClient');
const { createLogger } = require('../../core/logger');
const { flags } = require('../../core/autonomous-os/feature-flags');
const { tenantInCohort } = require('../../core/autonomous-os/cohort');
const { hasTenantOwnerRole } = require('../../core/authz/roles');
const {
  KINDS,
  STATUSES,
  PRIORITIES,
} = require('../../core/operations/work-items');

const router = express.Router();
const log = createLogger('work-items-routes');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLOSED = new Set(['verified', 'dismissed', 'cancelled']);
const PRIORITY_RANK = Object.freeze({ critical: 0, high: 1, normal: 2, low: 3 });

function parseEnum(value, allowed) {
  if (value == null || value === '') return null;
  const normalized = String(value).trim().toLowerCase();
  return allowed.includes(normalized) ? normalized : null;
}

function parseListQuery(query = {}) {
  const limitRaw = Number(query.limit);
  const limit = Number.isFinite(limitRaw)
    ? Math.max(1, Math.min(Math.trunc(limitRaw), 100))
    : 50;
  const kind = parseEnum(query.kind, KINDS);
  const status = parseEnum(query.status, STATUSES);
  const priority = parseEnum(query.priority, PRIORITIES);
  const department = typeof query.department === 'string'
    ? query.department.trim().slice(0, 80)
    : '';
  const includeClosed = query.include_closed === 'true';
  const errors = [];
  if (query.kind && !kind) errors.push('invalid_kind');
  if (query.status && !status) errors.push('invalid_status');
  if (query.priority && !priority) errors.push('invalid_priority');

  return {
    valid: errors.length === 0,
    errors,
    value: {
      limit,
      kind,
      status,
      priority,
      department: department || null,
      includeClosed,
    },
  };
}

function sortItems(items) {
  return [...items].sort((left, right) => {
    const priority = (PRIORITY_RANK[left.priority] ?? 9) - (PRIORITY_RANK[right.priority] ?? 9);
    if (priority !== 0) return priority;
    const leftDue = left.due_at ? new Date(left.due_at).getTime() : Number.POSITIVE_INFINITY;
    const rightDue = right.due_at ? new Date(right.due_at).getTime() : Number.POSITIVE_INFINITY;
    if (leftDue !== rightDue) return leftDue - rightDue;
    return new Date(right.created_at).getTime() - new Date(left.created_at).getTime();
  });
}

function requireControlPlane(req, res, next) {
  if (
    !flags.controlPlaneApi() ||
    !tenantInCohort(req.tenantId, 'FGA_OS_CONTROL_PLANE_TENANT_ALLOWLIST')
  ) {
    return res.status(404).json({ success: false, error: 'Not found' });
  }
  const currentRole = req.user?.app_metadata?.role;
  const currentTenant = req.user?.app_metadata?.tenant_id;
  if (!hasTenantOwnerRole(currentRole) || currentTenant !== req.tenantId) {
    return res.status(403).json({
      success: false,
      error: 'Current tenant-owner authority could not be verified',
    });
  }
  next();
}

router.use(requireControlPlane);

router.get('/', async (req, res) => {
  const parsed = parseListQuery(req.query);
  if (!parsed.valid) {
    return res.status(400).json({ success: false, error: 'Invalid filters', codes: parsed.errors });
  }

  try {
    const db = getUserClient(req);
    const filter = parsed.value;
    let query = db
      .from('work_items')
      .select(
        'id, tenant_id, schema_version, kind, department, title, summary, status, ' +
        'priority, priority_rank, authority_tier, assignee_type, assignee_id, source_type, source_id, ' +
        'entity_type, entity_id, verification_state, reason_code, sla_started_at, due_at, ' +
        'claimed_at, started_at, submitted_for_verification_at, verified_at, resolved_at, ' +
        'created_at, updated_at, revision'
      )
      .eq('tenant_id', req.tenantId);

    if (filter.kind) query = query.eq('kind', filter.kind);
    if (filter.status) query = query.eq('status', filter.status);
    if (filter.priority) query = query.eq('priority', filter.priority);
    if (filter.department) query = query.eq('department', filter.department);
    if (!filter.includeClosed && !filter.status) {
      query = query.not('status', 'in', '("verified","dismissed","cancelled")');
    }

    const { data, error } = await query
      .order('priority_rank', { ascending: true })
      .order('due_at', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(filter.limit);
    if (error) throw error;

    const items = sortItems(data || []);
    return res.json({
      success: true,
      items,
      page: { limit: filter.limit, returned: items.length },
    });
  } catch (error) {
    log.error('List failed', error);
    return res.status(500).json({ success: false, error: 'Unable to load work items' });
  }
});

router.get('/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    return res.status(400).json({ success: false, error: 'Invalid work item id' });
  }

  try {
    const db = getUserClient(req);
    const [itemResult, eventResult] = await Promise.all([
      db
        .from('work_items')
        .select(
          'id, tenant_id, schema_version, kind, department, title, summary, status, ' +
          'priority, priority_rank, authority_tier, assignee_type, assignee_id, ' +
          'source_type, source_id, entity_type, entity_id, action_protocol, ' +
          'acceptance_criteria, verification_state, verification_evidence, reason_code, ' +
          'sla_started_at, due_at, claimed_at, started_at, submitted_for_verification_at, ' +
          'verified_at, resolved_at, created_at, updated_at, revision'
        )
        .eq('tenant_id', req.tenantId)
        .eq('id', req.params.id)
        .maybeSingle(),
      db
        .from('work_item_events')
        .select(
          'id, tenant_id, work_item_id, schema_version, event_type, from_status, to_status, ' +
          'actor_type, actor_id, authority_tier, reason_code, evidence, occurred_at, created_at'
        )
        .eq('tenant_id', req.tenantId)
        .eq('work_item_id', req.params.id)
        .order('occurred_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(201),
    ]);
    if (itemResult.error) throw itemResult.error;
    if (eventResult.error) throw eventResult.error;
    if (!itemResult.data) {
      return res.status(404).json({ success: false, error: 'Not found' });
    }
    return res.json({
      success: true,
      item: itemResult.data,
      events: (eventResult.data || []).slice(0, 200).reverse(),
      event_page: {
        returned: Math.min(eventResult.data?.length || 0, 200),
        has_more: (eventResult.data?.length || 0) > 200,
      },
    });
  } catch (error) {
    log.error('Detail failed', error);
    return res.status(500).json({ success: false, error: 'Unable to load work item' });
  }
});

module.exports = router;
module.exports._internal = {
  CLOSED,
  parseListQuery,
  requireControlPlane,
  sortItems,
};
