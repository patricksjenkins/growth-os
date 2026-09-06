'use strict';

/**
 * FGA growth ICP contract.
 *
 * Patrick's rule is deliberately broader than an industry list: any legitimate
 * owner-operated business may qualify, but it must have fewer than 10
 * employees. Unknown headcount is not a rejection; it is an evidence gap that
 * must return to enrichment before autonomous outreach.
 */
const MIN_EMPLOYEES = 1;
const EXCLUSIVE_EMPLOYEE_CEILING = 10;
const ICP_VERSION = 'fga-wide-net-under-10-v1';
const { evidenceMatchesLead } = require('./employee-evidence');

function positiveNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseEmployeeRange(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const match = raw.match(/(\d+)\s*(?:-|to)\s*(\d+)/i);
  if (!match) {
    const exact = positiveNumber(raw);
    return exact ? { min: exact, max: exact, source: 'size_exact' } : null;
  }
  const first = Number(match[1]);
  const second = Number(match[2]);
  return { min: Math.min(first, second), max: Math.max(first, second), source: 'size_range' };
}

function employeeEvidence(lead = {}) {
  const actual = positiveNumber(lead.employee_count_actual);
  if (actual !== null) {
    const proof = evidenceMatchesLead(lead);
    return {
      min: actual,
      max: actual,
      count: actual,
      source: proof ? 'employee_count_evidence' : 'employee_count_actual_unverified',
      confirmed: Boolean(proof),
      proof,
    };
  }

  // Legacy prospect records used employee_count before employee_count_actual
  // became the canonical column. Read it for compatibility, but identify the
  // source in the evidence snapshot.
  const legacy = positiveNumber(lead.employee_count);
  if (legacy !== null) return { min: legacy, max: legacy, count: legacy, source: 'employee_count_legacy_unverified', confirmed: false };

  const range = parseEmployeeRange(lead.size);
  if (range) return { ...range, count: range.min === range.max ? range.min : null, confirmed: false };
  return { min: null, max: null, count: null, source: null, confirmed: false };
}

function evaluateEmployeeFit(lead = {}) {
  const evidence = employeeEvidence(lead);
  if (evidence.max === null) {
    return {
      decision: 'needs_evidence',
      eligible: false,
      reason: 'employee_count_unknown',
      evidence,
      icp_version: ICP_VERSION,
    };
  }
  if (evidence.min >= EXCLUSIVE_EMPLOYEE_CEILING) {
    return {
      decision: 'ineligible',
      eligible: false,
      reason: 'employee_count_10_or_more',
      evidence,
      icp_version: ICP_VERSION,
    };
  }
  // A range such as 5-15 does not prove the business is under 10.
  if (evidence.max >= EXCLUSIVE_EMPLOYEE_CEILING) {
    return {
      decision: 'needs_evidence',
      eligible: false,
      reason: 'employee_range_crosses_ceiling',
      evidence,
      icp_version: ICP_VERSION,
    };
  }
  if (!evidence.confirmed) {
    return {
      decision: 'needs_evidence',
      eligible: false,
      reason: evidence.source && evidence.source.includes('unverified')
        ? 'employee_count_provenance_missing'
        : 'employee_range_unverified',
      evidence,
      icp_version: ICP_VERSION,
    };
  }
  if (evidence.max < MIN_EMPLOYEES) {
    return {
      decision: 'needs_evidence',
      eligible: false,
      reason: 'employee_count_invalid',
      evidence,
      icp_version: ICP_VERSION,
    };
  }
  return {
    decision: 'eligible',
    eligible: true,
    reason: 'confirmed_under_10',
    evidence,
    icp_version: ICP_VERSION,
  };
}

module.exports = {
  MIN_EMPLOYEES,
  EXCLUSIVE_EMPLOYEE_CEILING,
  ICP_VERSION,
  parseEmployeeRange,
  employeeEvidence,
  evaluateEmployeeFit,
};
