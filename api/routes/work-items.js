/**
 * Canonical tenant work-item control plane.
 *
 * The entire surface is hidden unless the read flag and exact tenant cohort
 * both allow it. Commands require a second write flag and a narrower cohort,
 * then execute only through migration 072's atomic service-role RPCs.
 */

'use strict';

const express = require('express');
const { getUserClient } = require('../../db/userClient');
const { getServiceClient } = require('../../db/client');
const { createLogger } = require('../../core/logger');
const {
  flags,
  snapshot: autonomousFlagSnapshot,
} = require('../../core/autonomous-os/feature-flags');
const { tenantInCohort } = require('../../core/autonomous-os/cohort');
const { evaluateAuthority } = require('../../core/authz/authority');
const {
  KINDS,
  STATUSES,
  PRIORITIES,
  planWorkItemCreate,
  planWorkItemTransition,
} = require('../../core/operations/work-items');

const router = express.Router();
const log = createLogger('work-items-routes');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLOSED = new Set(['verified', 'dismissed', 'cancelled']);
const PRIORITY_RANK = Object.freeze({ critical: 0, high: 1, normal: 2, low: 3 });
const COMMAND_ITEM_FIELDS = Object.freeze([
  'id', 'tenant_id', 'schema_version', 'kind', 'department', 'title', 'summary',
  'status', 'priority', 'authority_tier', 'assignee_type', 'assignee_id',
  'source_type', 'source_id', 'entity_type', 'entity_id', 'verification_state',
  'reason_code', 'sla_started_at', 'due_at', 'claimed_at', 'started_at',
  'submitted_for_verification_at', 'verified_at', 'resolved_at', 'created_at',
  'updated_at', 'revision',
]);
const COMMAND_EVENT_FIELDS = Object.freeze([
  'id', 'tenant_id', 'work_item_id', 'schema_version', 'event_type',
  'from_status', 'to_status', 'actor_type', 'actor_id', 'authority_tier',
  'reason_code', 'occurred_at', 'created_at',
]);

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
  const authority = evaluateAuthority({
    actor: currentHumanActor(req),
    action: 'work_item.read',
    targetTenantId: req.tenantId,
  });
  if (!authority.allowed) {
    return res.status(403).json({
      success: false,
      error: 'Current tenant-owner authority could not be verified',
    });
  }
  next();
}

function requireControlPlaneWrites(req, res, next) {
  if (
    !flags.decisionQueueWrites() ||
    !tenantInCohort(req.tenantId, 'FGA_OS_DECISION_QUEUE_WRITE_TENANT_ALLOWLIST')
  ) {
    return res.status(404).json({ success: false, error: 'Not found' });
  }
  next();
}

function currentHumanActor(req) {
  return {
    type: 'human',
    id: req.userId || req.user?.id || '',
    role: req.user?.app_metadata?.role,
    tenantId: req.user?.app_metadata?.tenant_id,
    authority_tier: 'owner',
  };
}

function pickFields(value, fields) {
  return Object.fromEntries(fields.map(field => [field, value[field]]));
}

function hasFields(value, fields) {
  return fields.every(field => Object.hasOwn(value, field));
}

function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(new Date(value).getTime());
}

function ownerCreateInputErrors(body = {}) {
  const errors = [];
  if (body.source_type !== 'manual_owner') {
    errors.push('source_type_must_be_manual_owner');
  }
  if (body.entity_type != null || body.entity_id != null || body.attention_queue_id != null) {
    errors.push('server_validated_relationship_required');
  }
  if (
    (body.assignee_type != null && body.assignee_type !== 'unassigned') ||
    body.assignee_id != null
  ) {
    errors.push('create_assignment_not_supported');
  }
  return errors;
}

function ownerTransitionInputErrors(request = {}, actor) {
  if (request.to_status !== 'claimed') return [];
  if (request.assignee_type !== 'human' || request.assignee_id !== actor.id) {
    return ['owner_may_claim_only_for_current_user'];
  }
  return [];
}

function validateRpcResult({
  data,
  tenantId,
  workItemId,
  operation,
  toStatus,
  actor,
}) {
  const allowedOutcomes = operation === 'create'
    ? new Set(['created', 'replay'])
    : new Set(['transitioned', 'replay']);
  const item = data?.work_item;
  const event = data?.event;
  const valid = data && typeof data === 'object'
    && allowedOutcomes.has(data.outcome)
    && item && typeof item === 'object'
    && event && typeof event === 'object'
    && hasFields(item, COMMAND_ITEM_FIELDS)
    && hasFields(event, COMMAND_EVENT_FIELDS)
    && UUID_RE.test(String(item.id || ''))
    && UUID_RE.test(String(event.id || ''))
    && item.tenant_id === tenantId
    && event.tenant_id === tenantId
    && event.work_item_id === item.id
    && (!workItemId || item.id === workItemId)
    && Number.isInteger(Number(item.revision))
    && Number(item.revision) > 0
    && Number.isInteger(Number(item.schema_version))
    && Number(item.schema_version) > 0
    && Number.isInteger(Number(event.schema_version))
    && Number(event.schema_version) > 0
    && KINDS.includes(item.kind)
    && STATUSES.includes(item.status)
    && PRIORITIES.includes(item.priority)
    && typeof item.department === 'string' && item.department.length > 0
    && typeof item.title === 'string' && item.title.length > 0
    && validTimestamp(item.created_at)
    && validTimestamp(item.updated_at)
    && validTimestamp(event.occurred_at)
    && validTimestamp(event.created_at)
    && event.actor_type === actor?.type
    && event.actor_id === actor?.id
    && event.authority_tier === actor?.authority_tier
    && (
      operation !== 'create'
        ? event.event_type === toStatus && event.to_status === toStatus
        : event.event_type === 'created' && event.to_status === 'open'
    )
    && (
      data.outcome === 'replay' ||
      (operation === 'create' && item.status === 'open') ||
      item.status === toStatus
    );
  if (!valid) {
    const error = new Error('work_item_rpc_contract_invalid');
    error.code = 'FGA_RPC_CONTRACT';
    throw error;
  }
  return {
    contract_version: 1,
    outcome: data.outcome,
    replay_semantics: data.outcome === 'replay'
      ? 'event_replayed_item_current'
      : null,
    item: pickFields(item, COMMAND_ITEM_FIELDS),
    event: pickFields(event, COMMAND_EVENT_FIELDS),
  };
}

function buildCreateRpcArgs(plan) {
  const row = plan.row;
  return {
    p_tenant_id: row.tenant_id,
    p_kind: row.kind,
    p_department: row.department,
    p_title: row.title,
    p_source_type: row.source_type,
    p_source_id: row.source_id,
    p_idempotency_key: row.idempotency_key,
    p_request_fingerprint: plan.event.request_fingerprint,
    p_actor_type: plan.event.actor_type,
    p_actor_id: plan.event.actor_id,
    p_actor_authority_tier: plan.event.authority_tier,
    p_summary: row.summary,
    p_priority: row.priority,
    p_required_authority_tier: row.authority_tier,
    p_assignee_type: row.assignee_type,
    p_assignee_id: row.assignee_id,
    p_entity_type: row.entity_type,
    p_entity_id: row.entity_id,
    p_attention_queue_id: row.attention_queue_id,
    p_action_protocol: row.action_protocol,
    p_acceptance_criteria: row.acceptance_criteria,
    p_due_at: row.due_at,
    p_sla_started_at: row.sla_started_at,
  };
}

function buildTransitionRpcArgs({ tenantId, workItemId, plan, request }) {
  return {
    p_tenant_id: tenantId,
    p_work_item_id: workItemId,
    p_expected_revision: Number(request.expected_revision),
    p_to_status: plan.event.to_status,
    p_idempotency_key: plan.event.idempotency_key,
    p_request_fingerprint: plan.event.request_fingerprint,
    p_actor_type: plan.event.actor_type,
    p_actor_id: plan.event.actor_id,
    p_actor_authority_tier: plan.event.authority_tier,
    p_reason_code: plan.event.reason_code,
    p_assignee_type: plan.patch.assignee_type || null,
    p_assignee_id: plan.patch.assignee_id || null,
    p_verification_state: plan.patch.verification_state || null,
    p_verification_evidence: request.to_status === 'verified'
      ? plan.patch.verification_evidence
      : null,
  };
}

function rpcErrorResponse(error) {
  const code = String(error?.code || '');
  const message = String(error?.message || '');
  if (code === '23505' || message.includes('idempotency')) {
    return { status: 409, code: 'IDEMPOTENCY_CONFLICT' };
  }
  if (code === '40001' || message.includes('revision_conflict')) {
    return { status: 409, code: 'REVISION_CONFLICT' };
  }
  if (code === 'P0002' || message.includes('not_found_for_tenant')) {
    return { status: 404, code: 'NOT_FOUND' };
  }
  if (code === '42501' || message.includes('authority')) {
    return { status: 403, code: 'AUTHORITY_DENIED' };
  }
  if (code === 'FGA_RPC_CONTRACT') {
    return { status: 502, code: 'INVALID_COMMAND_RESULT' };
  }
  return { status: 500, code: 'WORK_ITEM_COMMAND_FAILED' };
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

router.post('/', requireControlPlaneWrites, async (req, res) => {
  const actor = currentHumanActor(req);
  const ownerInputErrors = ownerCreateInputErrors(req.body);
  if (ownerInputErrors.length) {
    return res.status(400).json({
      success: false,
      error: 'Invalid work item',
      codes: ownerInputErrors,
    });
  }
  const plan = planWorkItemCreate({
    ...(req.body || {}),
    tenant_id: req.tenantId,
  }, {
    actor,
    flagSnapshot: autonomousFlagSnapshot(),
    now: new Date().toISOString(),
  });
  if (!plan.ok) {
    const authorityFailure = plan.errors.some(error =>
      error.includes('authority') || error.endsWith('_disabled'));
    return res.status(authorityFailure ? 403 : 400).json({
      success: false,
      error: authorityFailure ? 'Work-item authority denied' : 'Invalid work item',
      codes: plan.errors,
    });
  }

  try {
    const { data, error } = await getServiceClient()
      .rpc('work_item_create_rpc', buildCreateRpcArgs(plan));
    if (error) throw error;
    const result = validateRpcResult({
      data,
      tenantId: req.tenantId,
      operation: 'create',
      actor,
    });
    return res.status(result.outcome === 'created' ? 201 : 200).json({
      success: true,
      ...result,
    });
  } catch (error) {
    const response = rpcErrorResponse(error);
    log.error(`Create command failed: ${response.code}`);
    return res.status(response.status).json({
      success: false,
      error: 'Unable to create work item',
      code: response.code,
    });
  }
});

router.post('/:id/transitions', requireControlPlaneWrites, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    return res.status(400).json({ success: false, error: 'Invalid work item id' });
  }

  try {
    const db = getUserClient(req);
    const { data: item, error: readError } = await db
      .from('work_items')
      .select(
        'id, tenant_id, status, authority_tier, assignee_type, assignee_id, ' +
        'verification_state, started_at, revision'
      )
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .maybeSingle();
    if (readError) throw readError;
    if (!item) {
      return res.status(404).json({ success: false, error: 'Not found' });
    }

    const actor = currentHumanActor(req);
    const request = req.body || {};
    const ownerInputErrors = ownerTransitionInputErrors(request, actor);
    if (ownerInputErrors.length) {
      return res.status(400).json({
        success: false,
        error: 'Invalid transition',
        codes: ownerInputErrors,
      });
    }
    const plan = planWorkItemTransition(item, request, {
      actor,
      flagSnapshot: autonomousFlagSnapshot(),
      now: new Date().toISOString(),
    });
    if (!plan.ok) {
      const conflict = plan.errors.includes('revision_conflict');
      const authorityFailure = plan.errors.some(error =>
        error.includes('authority') || error.endsWith('_disabled'));
      return res.status(conflict ? 409 : authorityFailure ? 403 : 400).json({
        success: false,
        error: conflict
          ? 'Work item changed; refresh before retrying'
          : authorityFailure
            ? 'Work-item authority denied'
            : 'Invalid transition',
        codes: plan.errors,
      });
    }

    const { data, error } = await getServiceClient().rpc(
      'work_item_transition_rpc',
      buildTransitionRpcArgs({
        tenantId: req.tenantId,
        workItemId: req.params.id,
        plan,
        request,
      })
    );
    if (error) throw error;
    const result = validateRpcResult({
      data,
      tenantId: req.tenantId,
      workItemId: req.params.id,
      operation: 'transition',
      toStatus: plan.event.to_status,
      actor,
    });
    return res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    const response = rpcErrorResponse(error);
    log.error(`Transition command failed: ${response.code}`);
    return res.status(response.status).json({
      success: false,
      error: 'Unable to transition work item',
      code: response.code,
    });
  }
});

module.exports = router;
module.exports._internal = {
  CLOSED,
  buildCreateRpcArgs,
  buildTransitionRpcArgs,
  currentHumanActor,
  ownerCreateInputErrors,
  ownerTransitionInputErrors,
  parseListQuery,
  hasFields,
  requireControlPlane,
  requireControlPlaneWrites,
  rpcErrorResponse,
  sortItems,
  validTimestamp,
  validateRpcResult,
};
