'use strict';

const crypto = require('node:crypto');
const {
  DEPARTMENT_KEYS,
  departmentContract,
} = require('./catalog');

const DATABASE_DEPARTMENT_KEYS = Object.freeze({
  reliability: 'reliability_security_agent_ops',
  revenue: 'revenue_sales',
  onboarding: 'onboarding_implementation',
  client_success: 'client_success_support',
  finance: 'finance_data_governance',
  marketing: 'marketing_brand',
  product_engineering: 'product_engineering',
});

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => (
      `${JSON.stringify(key)}:${stable(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function deterministicUuid(value) {
  const bytes = Buffer.from(sha256(value).slice(0, 32), 'hex');
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16),
    hex.slice(16, 20), hex.slice(20),
  ].join('-');
}

function reportContractDefinition(departmentKey) {
  const contract = departmentContract(departmentKey);
  const department = DATABASE_DEPARTMENT_KEYS[departmentKey];
  if (!department) throw new TypeError(`Unknown report department: ${departmentKey}`);
  const definition = {
    schema_version: 1,
    department,
    mission: contract.mission,
    kpis: contract.kpis,
    accepted_report_types: contract.acceptedReportTypes,
    required_fields: [
      'source_report_id', 'reporting_period_start', 'reporting_period_end',
      'report_digest', 'outcome_health', 'structured_summary',
    ],
    evidence_policy: {
      exact_tenant_required: true,
      immutable_source_required: true,
      contact_data_forbidden: true,
      owner_acceptance_required: true,
    },
  };
  return {
    departmentKey,
    department,
    contractVersion: 1,
    contractIdForTenant: tenantId => deterministicUuid(
      `department-report-contract:${tenantId}:${department}:v1`,
    ),
    schemaDigest: sha256(stable(definition)),
    definition,
  };
}

function listReportContractDefinitions() {
  return DEPARTMENT_KEYS.map(reportContractDefinition);
}

module.exports = {
  DATABASE_DEPARTMENT_KEYS,
  deterministicUuid,
  listReportContractDefinitions,
  reportContractDefinition,
  sha256,
  stable,
};
