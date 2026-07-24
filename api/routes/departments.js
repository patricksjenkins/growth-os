/**
 * Supervised Department Head read API.
 *
 * This surface is hidden unless the global feature flag and exact tenant
 * cohort both allow it. It exposes the executable seven-department catalog
 * and tenant-bound report contracts/evidence through the caller's JWT-bound
 * database client. There are intentionally no command, acceptance, activation,
 * or production-authority routes.
 */

'use strict';

const express = require('express');
const { getUserClient } = require('../../db/userClient');
const { createLogger } = require('../../core/logger');
const { flags } = require('../../core/autonomous-os/feature-flags');
const { tenantInCohort } = require('../../core/autonomous-os/cohort');
const { evaluateAuthority } = require('../../core/authz/authority');
const {
  DEPARTMENT_KEYS,
  departmentContract,
  listDepartmentContracts,
} = require('../../core/departments/catalog');

const router = express.Router();
const log = createLogger('department-head-routes');

const DATABASE_DEPARTMENT_KEYS = Object.freeze({
  reliability: 'reliability_security_agent_ops',
  revenue: 'revenue_sales',
  onboarding: 'onboarding_implementation',
  client_success: 'client_success_support',
  finance: 'finance_data_governance',
  marketing: 'marketing_brand',
  product_engineering: 'product_engineering',
});

function currentHumanActor(req) {
  return {
    type: 'human',
    id: req.userId || req.user?.id || '',
    role: req.user?.app_metadata?.role,
    tenantId: req.user?.app_metadata?.tenant_id,
  };
}

function requireDepartmentRead(req, res, next) {
  if (
    !flags.departmentHeads()
    || !tenantInCohort(req.tenantId, 'FGA_OS_DEPARTMENT_HEAD_TENANT_ALLOWLIST')
  ) {
    return res.status(404).json({ success: false, error: 'Not found' });
  }
  const authority = evaluateAuthority({
    actor: currentHumanActor(req),
    action: 'department.read',
    targetTenantId: req.tenantId,
  });
  if (!authority.allowed) {
    return res.status(403).json({
      success: false,
      error: 'Current tenant-owner department access could not be verified',
    });
  }
  next();
}

function parseDepartmentQuery(query = {}) {
  const limitNumber = Number(query.limit);
  const limit = Number.isFinite(limitNumber)
    ? Math.max(1, Math.min(Math.trunc(limitNumber), 100))
    : 25;
  const departmentKey = typeof query.department === 'string'
    ? query.department.trim().toLowerCase()
    : '';
  return {
    valid: !departmentKey || DEPARTMENT_KEYS.includes(departmentKey),
    value: {
      departmentKey: departmentKey || null,
      databaseDepartmentKey: departmentKey
        ? DATABASE_DEPARTMENT_KEYS[departmentKey] || null
        : null,
      limit,
    },
  };
}

function publicContract(contract, tenantId) {
  return {
    tenant_id: tenantId,
    key: contract.key,
    name: contract.name,
    mission: contract.mission,
    kpis: contract.kpis,
    accepted_report_types: contract.acceptedReportTypes,
    supervised_actions: contract.supervisedActions,
    owner_approval_actions: contract.ownerApprovalActions,
    prohibited_actions: contract.prohibitedActions,
    universal_prohibitions: contract.universalProhibitions,
    execution_mode: contract.executionMode,
    production_write_authority: contract.productionWriteAuthority,
  };
}

router.use(requireDepartmentRead);

router.get('/catalog', (req, res) => res.json({
  success: true,
  tenant_id: req.tenantId,
  departments: listDepartmentContracts().map(
    contract => publicContract(contract, req.tenantId),
  ),
}));

router.get('/reports', async (req, res) => {
  const parsed = parseDepartmentQuery(req.query);
  if (!parsed.valid) {
    return res.status(400).json({ success: false, error: 'Invalid department' });
  }
  try {
    const db = getUserClient(req);
    let query = db
      .from('department_reports')
      .select(
        'id, tenant_id, department_report_contract_id, department, ' +
        'reporting_period_start, reporting_period_end, report_digest, ' +
        'report_state, revision, outcome_health, structured_summary, ' +
        'submitted_at, accepted_by, accepted_at, acceptance_evidence_digest, ' +
        'created_at, updated_at'
      )
      .eq('tenant_id', req.tenantId);
    if (parsed.value.databaseDepartmentKey) {
      query = query.eq('department', parsed.value.databaseDepartmentKey);
    }
    const { data, error } = await query
      .order('reporting_period_end', { ascending: false })
      .limit(parsed.value.limit);
    if (error) throw error;
    return res.json({
      success: true,
      tenant_id: req.tenantId,
      reports: data || [],
      page: { limit: parsed.value.limit, returned: data?.length || 0 },
    });
  } catch (error) {
    log.error('Department report list failed', error);
    return res.status(500).json({
      success: false,
      error: 'Unable to load department reports',
    });
  }
});

router.get('/:departmentKey', async (req, res) => {
  const departmentKey = String(req.params.departmentKey || '').trim().toLowerCase();
  if (!DEPARTMENT_KEYS.includes(departmentKey)) {
    return res.status(404).json({ success: false, error: 'Not found' });
  }
  const databaseDepartmentKey = DATABASE_DEPARTMENT_KEYS[departmentKey];
  try {
    const db = getUserClient(req);
    const [contractsResult, reportsResult] = await Promise.all([
      db
        .from('department_report_contracts')
        .select(
          'id, tenant_id, department, contract_version, schema_digest, ' +
          'acceptance_state, revision, accepted_by, accepted_at, ' +
          'acceptance_evidence_digest, created_at, updated_at'
        )
        .eq('tenant_id', req.tenantId)
        .eq('department', databaseDepartmentKey)
        .order('contract_version', { ascending: false })
        .limit(20),
      db
        .from('department_reports')
        .select(
          'id, tenant_id, department_report_contract_id, department, ' +
          'reporting_period_start, reporting_period_end, report_digest, ' +
          'report_state, revision, outcome_health, structured_summary, ' +
          'submitted_at, accepted_by, accepted_at, acceptance_evidence_digest, ' +
          'created_at, updated_at'
        )
        .eq('tenant_id', req.tenantId)
        .eq('department', databaseDepartmentKey)
        .order('reporting_period_end', { ascending: false })
        .limit(25),
    ]);
    if (contractsResult.error) throw contractsResult.error;
    if (reportsResult.error) throw reportsResult.error;
    return res.json({
      success: true,
      tenant_id: req.tenantId,
      department: publicContract(departmentContract(departmentKey), req.tenantId),
      report_contracts: contractsResult.data || [],
      reports: reportsResult.data || [],
    });
  } catch (error) {
    log.error('Department detail failed', error);
    return res.status(500).json({
      success: false,
      error: 'Unable to load department evidence',
    });
  }
});

module.exports = router;
module.exports._internal = {
  DATABASE_DEPARTMENT_KEYS,
  parseDepartmentQuery,
  publicContract,
  requireDepartmentRead,
};
