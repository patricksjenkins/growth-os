'use strict';

/**
 * FGA growth ICP contract.
 *
 * Patrick's rule is deliberately broader than an industry list. Businesses
 * with 1-9 employees are the sweet spot; 10-19 employee small businesses are
 * also eligible. Size is a prioritization signal, not a reason to freeze an
 * otherwise-contactable prospect. Affirmative evidence of 20+ employees
 * excludes autonomous outreach; a wholly unknown size remains a research gap.
 */
const MIN_EMPLOYEES = 1;
const SWEET_SPOT_EMPLOYEE_MAX = 9;
const EXCLUSIVE_EMPLOYEE_CEILING = 20;
const ICP_VERSION = 'fga-wide-net-small-business-v2';
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
      segment: 'research_only',
      evidence,
      icp_version: ICP_VERSION,
    };
  }
  if (evidence.min >= EXCLUSIVE_EMPLOYEE_CEILING) {
    return {
      decision: 'ineligible',
      eligible: false,
      reason: 'employee_count_20_or_more',
      evidence,
      icp_version: ICP_VERSION,
    };
  }
  // A range that crosses 20 is uncertain: it might be a fit, but do not
  // autonomously contact it until the upper bound is resolved.
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
      decision: 'eligible',
      eligible: true,
      reason: 'estimated_small_business',
      segment: evidence.max <= SWEET_SPOT_EMPLOYEE_MAX
        ? 'estimated_sweet_spot_1_9'
        : 'estimated_small_business_10_19',
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
    segment: evidence.max <= SWEET_SPOT_EMPLOYEE_MAX ? 'verified_sweet_spot_1_9' : 'verified_small_business_10_19',
    reason: evidence.proof?.method === 'provider_estimate'
      ? (evidence.max <= SWEET_SPOT_EMPLOYEE_MAX
          ? 'provider_estimated_sweet_spot'
          : 'provider_estimated_small_business')
      : (evidence.max <= SWEET_SPOT_EMPLOYEE_MAX
          ? 'confirmed_sweet_spot'
          : 'confirmed_small_business'),
    evidence,
    icp_version: ICP_VERSION,
  };
}

module.exports = {
  MIN_EMPLOYEES,
  SWEET_SPOT_EMPLOYEE_MAX,
  EXCLUSIVE_EMPLOYEE_CEILING,
  ICP_VERSION,
  parseEmployeeRange,
  employeeEvidence,
  evaluateEmployeeFit,
};
