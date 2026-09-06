'use strict';

/**
 * Apollo organization enrichment for FGA's employee-count evidence gate.
 *
 * This adapter deliberately returns a minimized, typed result. It never
 * exposes Apollo's raw payload, the API key, a prospect name, or a domain to
 * callers. Apollo describes the field as an estimated employee count, so the
 * evidence is recorded as provider_estimate rather than an exact public fact.
 */

const axios = require('axios');
const { withRetry } = require('./_retry');
const { acceptProviderEmployeeEvidence } = require('../core/growth/employee-evidence');

const ENDPOINT = 'https://api.apollo.io/api/v1/organizations/enrich';
let rejectedCredential = null;

function normalizeDomain(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  try {
    const url = new URL(/^https?:\/\//.test(raw) ? raw : `https://${raw}`);
    return url.hostname.replace(/^www\./, '').replace(/\.$/, '') || null;
  } catch (_) {
    return raw
      .replace(/^www\./, '')
      .split('/')[0]
      .replace(/\.$/, '') || null;
  }
}

function responseDomain(organization = {}) {
  return normalizeDomain(
    organization.primary_domain
      || organization.domain
      || organization.website_url
      || organization.website,
  );
}

function safeFailure(reason, { retryable = false, status = null } = {}) {
  return { ok: false, reason, retryable, status };
}

async function enrichOrganizationHeadcount({ domain, name = null } = {}, options = {}) {
  const requestedDomain = normalizeDomain(domain);
  if (!requestedDomain) return safeFailure('domain_missing');

  const key = String(options.apiKey ?? process.env.APOLLO_API_KEY ?? '').trim();
  if (!key) return safeFailure('not_configured');
  if (!options.httpClient && rejectedCredential === key) {
    return safeFailure('credential_rejected');
  }

  const client = options.httpClient || axios;
  let response;
  try {
    response = await withRetry(
      () => client.get(ENDPOINT, {
        params: { domain: requestedDomain, ...(name ? { name } : {}) },
        headers: { 'x-api-key': key, accept: 'application/json' },
        timeout: 30_000,
      }),
      { attempts: 3 },
    );
  } catch (error) {
    const status = Number(error.response?.status || error.status || 0) || null;
    if (status === 401 || status === 403) {
      if (!options.httpClient) rejectedCredential = key;
      return safeFailure(status === 401 ? 'credential_rejected' : 'scope_rejected', { status });
    }
    if (status === 404 || status === 422) return safeFailure('organization_not_found', { status });
    return safeFailure('provider_unavailable', { retryable: true, status });
  }

  const organization = response?.data?.organization || null;
  if (!organization) return safeFailure('organization_not_found', { status: response?.status || null });

  const matchedDomain = responseDomain(organization);
  const domainMatched = Boolean(matchedDomain && matchedDomain === requestedDomain);
  if (!domainMatched) return safeFailure('domain_mismatch', { status: response?.status || null });

  const count = Number(organization.estimated_num_employees);
  const organizationId = String(organization.id || '').trim();
  const evidence = acceptProviderEmployeeEvidence({
    count,
    source: organizationId ? `apollo:organization:${organizationId}` : null,
    confidence: 0.85,
    provider: 'apollo',
    domainMatched,
  });
  if (!evidence) return safeFailure('employee_count_unavailable', { status: response?.status || null });

  try {
    if (options.httpClient) return { ok: true, evidence, status: response?.status || 200 };
    require('../core/ai-safety/usage-tracker').recordUsage({
      provider: 'apollo',
      model: 'organization-enrichment',
      operationType: 'company_enrichment',
      estimatedCostUsd: Number(process.env.APOLLO_ORG_COST_USD || 0),
      isAutomated: true,
      requestSource: 'integrations/apollo-organization.js:enrichOrganizationHeadcount',
    }).catch(() => {});
  } catch (_) { /* evidence lookup must not depend on usage telemetry */ }

  return { ok: true, evidence, status: response?.status || 200 };
}

function resetCredentialCacheForTest() {
  rejectedCredential = null;
}

module.exports = {
  enrichOrganizationHeadcount,
  normalizeDomain,
  _test: { responseDomain, resetCredentialCacheForTest },
};
