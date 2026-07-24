/**
 * Calendarless Scheduling Center read API.
 *
 * The target workflow is FGA-owned fixed availability plus a canonical
 * appointment ledger. This route does not expose calendar references,
 * provider booking URLs, customer contact details, or mutation commands.
 * It remains hidden unless a global flag and exact tenant cohort both allow
 * access, then relies on the caller's JWT-bound database client and RLS.
 */

'use strict';

const express = require('express');
const { getUserClient } = require('../../db/userClient');
const { createLogger } = require('../../core/logger');
const { flags } = require('../../core/autonomous-os/feature-flags');
const { tenantInCohort } = require('../../core/autonomous-os/cohort');
const { evaluateAuthority } = require('../../core/authz/authority');

const router = express.Router();
const log = createLogger('scheduling-center-routes');
const STATUSES = new Set([
  'needed',
  'invitation_ready',
  'invited',
  'scheduled',
  'prepared',
  'completed',
  'no_show',
  'cancelled',
  'reschedule_needed',
  'failed',
]);

function currentHumanActor(req) {
  return {
    type: 'human',
    id: req.userId || req.user?.id || '',
    role: req.user?.app_metadata?.role,
    tenantId: req.user?.app_metadata?.tenant_id,
  };
}

function requireSchedulingRead(req, res, next) {
  if (
    !flags.schedulingCenterApi()
    || !tenantInCohort(req.tenantId, 'FGA_OS_SCHEDULING_CENTER_TENANT_ALLOWLIST')
  ) {
    return res.status(404).json({ success: false, error: 'Not found' });
  }
  const authority = evaluateAuthority({
    actor: currentHumanActor(req),
    action: 'scheduling.read',
    targetTenantId: req.tenantId,
  });
  if (!authority.allowed) {
    return res.status(403).json({
      success: false,
      error: 'Current tenant scheduling access could not be verified',
    });
  }
  next();
}

function parseSchedulingQuery(query = {}) {
  const status = typeof query.status === 'string'
    ? query.status.trim().toLowerCase()
    : '';
  const limitNumber = Number(query.limit);
  return {
    valid: !status || STATUSES.has(status),
    value: {
      status: status || null,
      limit: Number.isFinite(limitNumber)
        ? Math.max(1, Math.min(Math.trunc(limitNumber), 100))
        : 50,
    },
  };
}

function policyProjection(row) {
  if (!row) return null;
  const windows = Array.isArray(row.availability_rules?.windows)
    ? row.availability_rules.windows
    : [];
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    policy_key: row.policy_key,
    timezone: row.timezone,
    provider: row.provider,
    fixed_window_count: windows.length,
    minimum_notice_minutes: row.minimum_notice_minutes,
    buffer_before_minutes: row.buffer_before_minutes,
    buffer_after_minutes: row.buffer_after_minutes,
    maximum_days_ahead: row.maximum_days_ahead,
    reminder_policy_configured:
      !!row.reminder_policy && Object.keys(row.reminder_policy).length > 0,
    active: row.active === true,
    updated_at: row.updated_at,
  };
}

function controlProjection(row) {
  if (!row) {
    return {
      tenant_id: null,
      enabled: false,
      execution_mode: 'disabled',
      kill_switch_engaged: true,
      provider_dispatch_enabled: false,
      revision: 0,
    };
  }
  return {
    tenant_id: row.tenant_id,
    enabled: row.enabled === true,
    execution_mode: row.execution_mode,
    kill_switch_engaged: row.kill_switch_engaged !== false,
    provider_dispatch_enabled: row.provider_dispatch_enabled === true,
    revision: row.revision,
    updated_at: row.updated_at,
  };
}

function appointmentProjection(row, lifecycle = null) {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    policy_id: row.policy_id,
    lead_id: row.lead_id,
    customer_id: row.customer_id,
    appointment_type: row.appointment_type,
    status: row.status,
    provider: row.provider,
    scheduled_start: row.scheduled_start,
    scheduled_end: row.scheduled_end,
    attendee_timezone: row.attendee_timezone,
    preparation_document_id: row.preparation_document_id,
    outcome_code: row.outcome_code,
    follow_up_due_at: row.follow_up_due_at,
    exception_reason: row.exception_reason,
    created_at: row.created_at,
    updated_at: row.updated_at,
    lifecycle: lifecycle
      ? {
        tenant_id: lifecycle.tenant_id,
        lifecycle_state: lifecycle.lifecycle_state,
        revision: lifecycle.revision,
        reminder_count: lifecycle.reminder_count,
        next_reminder_at: lifecycle.next_reminder_at,
        exception_code: lifecycle.exception_code,
        exception_at: lifecycle.exception_at,
        last_action_at: lifecycle.last_action_at,
        updated_at: lifecycle.updated_at,
      }
      : null,
  };
}

router.use(requireSchedulingRead);

router.get('/', async (req, res) => {
  const parsed = parseSchedulingQuery(req.query);
  if (!parsed.valid) {
    return res.status(400).json({ success: false, error: 'Invalid scheduling status' });
  }
  try {
    const db = getUserClient(req);
    const [policiesResult, controlResult] = await Promise.all([
      db
        .from('scheduling_policies')
        .select(
          'id, tenant_id, policy_key, timezone, provider, availability_rules, ' +
          'minimum_notice_minutes, buffer_before_minutes, buffer_after_minutes, ' +
          'maximum_days_ahead, reminder_policy, active, updated_at'
        )
        .eq('tenant_id', req.tenantId)
        .order('active', { ascending: false })
        .order('updated_at', { ascending: false })
        .limit(20),
      db
        .from('scheduling_automation_controls')
        .select(
          'tenant_id, enabled, execution_mode, kill_switch_engaged, ' +
          'provider_dispatch_enabled, revision, updated_at'
        )
        .eq('tenant_id', req.tenantId)
        .maybeSingle(),
    ]);
    if (policiesResult.error) throw policiesResult.error;
    if (controlResult.error) throw controlResult.error;

    let appointmentQuery = db
      .from('appointment_workflows')
      .select(
        'id, tenant_id, policy_id, lead_id, customer_id, appointment_type, ' +
        'status, provider, scheduled_start, scheduled_end, attendee_timezone, ' +
        'preparation_document_id, outcome_code, follow_up_due_at, ' +
        'exception_reason, created_at, updated_at'
      )
      .eq('tenant_id', req.tenantId);
    if (parsed.value.status) {
      appointmentQuery = appointmentQuery.eq('status', parsed.value.status);
    }
    const appointmentsResult = await appointmentQuery
      .order('updated_at', { ascending: false })
      .limit(parsed.value.limit);
    if (appointmentsResult.error) throw appointmentsResult.error;

    const appointmentRows = appointmentsResult.data || [];
    let lifecycleRows = [];
    if (appointmentRows.length > 0) {
      const lifecycleResult = await db
        .from('appointment_lifecycle_controls')
        .select(
          'tenant_id, appointment_id, lifecycle_state, revision, reminder_count, ' +
          'next_reminder_at, exception_code, exception_at, last_action_at, updated_at'
        )
        .eq('tenant_id', req.tenantId)
        .in('appointment_id', appointmentRows.map(row => row.id));
      if (lifecycleResult.error) throw lifecycleResult.error;
      lifecycleRows = lifecycleResult.data || [];
    }
    const lifecycleByAppointment = new Map(
      lifecycleRows.map(row => [row.appointment_id, row])
    );
    const appointments = appointmentRows.map(
      row => appointmentProjection(row, lifecycleByAppointment.get(row.id))
    );
    const activePolicy = (policiesResult.data || []).find(row => row.active) || null;
    const control = controlProjection(controlResult.data);

    return res.json({
      success: true,
      tenant_id: req.tenantId,
      target_provider: 'fga_fixed_availability',
      external_calendar_required: false,
      policy: policyProjection(activePolicy),
      control: { ...control, tenant_id: control.tenant_id || req.tenantId },
      summary: {
        total: appointments.length,
        needs_action: appointments.filter(item => [
          'needed', 'invitation_ready', 'reschedule_needed', 'failed',
        ].includes(item.status)).length,
        scheduled: appointments.filter(item => item.status === 'scheduled').length,
        exceptions: appointments.filter(
          item => !!item.exception_reason || item.lifecycle?.lifecycle_state === 'exception'
        ).length,
        follow_up_due: appointments.filter(
          item => item.lifecycle?.lifecycle_state === 'follow_up_due'
        ).length,
      },
      appointments,
      page: { limit: parsed.value.limit, returned: appointments.length },
    });
  } catch (error) {
    log.error('Scheduling overview failed', error);
    return res.status(500).json({
      success: false,
      error: 'Unable to load scheduling evidence',
    });
  }
});

module.exports = router;
module.exports._internal = {
  STATUSES,
  appointmentProjection,
  controlProjection,
  parseSchedulingQuery,
  policyProjection,
  requireSchedulingRead,
};
