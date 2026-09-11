/**
 * Exact-tenant owner acceptance for canonical Department Head report schemas.
 *
 * This does not activate production authority and cannot send, publish, move
 * money, or touch customer tenants. The authenticated human owner authorizes
 * one immutable report schema; the service client is used only because the
 * database command RPC deliberately rejects direct authenticated writes.
 */

'use strict';

const express = require('express');
const { getUserClient } = require('../../db/userClient');
const { getServiceClient } = require('../../db/client');
const { createLogger } = require('../../core/logger');
const { flags } = require('../../core/autonomous-os/feature-flags');
const { tenantInCohort } = require('../../core/autonomous-os/cohort');
const { evaluateAuthority } = require('../../core/authz/authority');
const {
  planDepartmentReportCommand,
} = require('../../core/executive/chief-of-staff-planner');

const router = express.Router();
const log = createLogger('department-report-acceptance');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function currentHumanActor(req) {
  return {
    type: 'human',
    id: req.userId || req.user?.id || '',
    role: req.user?.app_metadata?.role,
    tenantId: req.user?.app_metadata?.tenant_id,
  };
}

function requireContractAcceptance(req, res, next) {
  if (!flags.departmentHeads()
      || !flags.departmentHeadWrites()
      || !tenantInCohort(req.tenantId, 'FGA_OS_DEPARTMENT_HEAD_TENANT_ALLOWLIST')
      || !tenantInCohort(req.tenantId, 'FGA_OS_DEPARTMENT_HEAD_WRITE_TENANT_ALLOWLIST')) {
    return res.status(404).json({ success: false, error: 'Not found' });
  }
  const authority = evaluateAuthority({
    actor: currentHumanActor(req),
    action: 'department.accept_report_contract',
    targetTenantId: req.tenantId,
  });
  if (!authority.allowed) {
    return res.status(403).json({
      success: false,
      error: 'Tenant-owner report contract acceptance could not be verified',
    });
  }
  next();
}

router.use(requireContractAcceptance);

router.post('/control/activate-shadow', async (req, res) => {
  try {
    const userDb = getUserClient(req);
    const { data: control, error: controlError } = await userDb
      .from('cos_supervision_controls')
      .select(
        'tenant_id, enabled, execution_mode, read_only, kill_switch_engaged, ' +
        'production_write_enabled, provider_dispatch_enabled, ' +
        'customer_communication_enabled, financial_action_enabled, revision'
      )
      .eq('tenant_id', req.tenantId)
      .maybeSingle();
    if (controlError) throw controlError;
    if (!control) return res.status(404).json({ success: false, error: 'Not found' });
    const actor = currentHumanActor(req);
    const authority = evaluateAuthority({
      actor,
      action: 'department.activate_chief_of_staff_shadow',
      targetTenantId: req.tenantId,
    });
    if (!authority.allowed) {
      return res.status(403).json({
        success: false,
        error: 'Tenant-owner shadow activation could not be verified',
      });
    }
    const serviceDb = getServiceClient();
    const { data, error } = await serviceDb.rpc('cos_shadow_activate_rpc', {
      p_tenant_id: req.tenantId,
      p_actor_id: actor.id,
      p_expected_revision: control.revision,
      p_evidence: {
        source_type: 'authenticated_owner_shadow_activation',
        source_id: `chief-of-staff-shadow:r${control.revision}`,
        observed_at: new Date().toISOString(),
      },
    });
    if (error) throw error;
    return res.json({
      success: true,
      tenant_id: req.tenantId,
      outcome: data?.outcome || 'activated',
      control: {
        execution_mode: data?.execution_mode || 'shadow',
        read_only: data?.read_only !== false,
        production_authority: false,
        revision: data?.revision || control.revision + 1,
      },
    });
  } catch (error) {
    log.error('Chief of Staff shadow activation failed', error);
    return res.status(500).json({ success: false, error: 'Unable to activate shadow control' });
  }
});

router.post('/contracts/:contractId/accept', async (req, res) => {
  const contractId = String(req.params.contractId || '').trim().toLowerCase();
  if (!UUID_RE.test(contractId)) {
    return res.status(400).json({ success: false, error: 'Invalid report contract' });
  }
  try {
    const userDb = getUserClient(req);
    const { data: contract, error: contractError } = await userDb
      .from('department_report_contracts')
      .select(
        'id, tenant_id, department, contract_version, schema_digest, ' +
        'acceptance_state, revision'
      )
      .eq('tenant_id', req.tenantId)
      .eq('id', contractId)
      .maybeSingle();
    if (contractError) throw contractError;
    if (!contract) return res.status(404).json({ success: false, error: 'Not found' });
    if (contract.acceptance_state === 'accepted') {
      return res.json({
        success: true,
        tenant_id: req.tenantId,
        contract: { id: contract.id, department: contract.department, state: 'accepted' },
        outcome: 'already_accepted',
      });
    }
    if (contract.acceptance_state !== 'draft') {
      return res.status(409).json({ success: false, error: 'Report contract is not acceptable' });
    }

    const actor = currentHumanActor(req);
    const observedAt = new Date().toISOString();
    const plan = planDepartmentReportCommand({
      command: 'accept_contract',
      tenantId: req.tenantId,
      department: contract.department,
      contractId: contract.id,
      contractVersion: contract.contract_version,
      schemaDigest: contract.schema_digest,
      expectedRevision: contract.revision,
      idempotencyKey: `accept-department-contract-${contract.id}-r${contract.revision}`,
      actorType: 'human',
      actorId: actor.id,
      authorityTier: 'owner',
      evidence: {
        source_type: 'authenticated_owner_acceptance',
        source_id: `department-contract:${contract.id}:r${contract.revision}`,
        observed_at: observedAt,
      },
      featureGateEnabled: true,
    });
    const serviceDb = getServiceClient();
    const { data, error } = await serviceDb.rpc(plan.rpc, plan.args);
    if (error) throw error;
    return res.json({
      success: true,
      tenant_id: req.tenantId,
      contract: {
        id: contract.id,
        department: contract.department,
        state: data?.state || 'accepted',
        revision: data?.revision || contract.revision + 1,
      },
      outcome: data?.outcome || 'applied',
    });
  } catch (error) {
    log.error('Department report contract acceptance failed', error);
    return res.status(500).json({ success: false, error: 'Unable to accept report contract' });
  }
});

module.exports = router;
module.exports._internal = { currentHumanActor, requireContractAcceptance };
