'use strict';

/**
 * Public LinkedIn company evidence through Apify.
 *
 * The selected Actor reads public organization pages without a LinkedIn login.
 * This adapter deliberately accepts only organization-level data, requires the
 * returned website to match the prospect's normalized domain, and returns a
 * minimized provider-estimate receipt. Names and LinkedIn search results never
 * become autonomous-send authority on their own.
 */

const axios = require('axios');
const { acceptProviderEmployeeEvidence } = require('../core/growth/employee-evidence');
const { normalizeDomain } = require('./apollo-organization');

const ACTOR_SLUG = 'harvestapi~linkedin-company';
const ENDPOINT = `https://api.apify.com/v2/acts/${ACTOR_SLUG}/run-sync-get-dataset-items`;
const TIMEOUT_MS = 120_000;
const DIRECT_MAX_ITEMS = 1;
const SEARCH_MAX_ITEMS = 3;
const DIRECT_MAX_CHARGE_USD = 0.01;
const SEARCH_MAX_CHARGE_USD = 0.02;
let rejectedCredential = null;

function safeFailure(reason, { retryable = false, status = null, attempted = false } = {}) {
  return { ok: false, reason, retryable, status, attempted };
}

function companyLinkedinUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const match = url.pathname.match(/^\/company\/([^/?#]+)\/?$/i);
    if (host !== 'linkedin.com' || !match) return null;
    return `https://www.linkedin.com/company/${match[1]}/`;
  } catch (_) {
    return null;
  }
}

function responseDomain(row = {}) {
  return normalizeDomain(
    row.website
      || row.websiteUrl
      || row.companyWebsite
      || row.domain,
  );
}

function responseEmployeeCount(row = {}) {
  const raw = row.employeeCount
    ?? row.employees
    ?? row.employee_count
    ?? row.staffCount;
  const count = Number(raw);
  return Number.isInteger(count) ? count : null;
}

function organizationId(row = {}) {
  const value = row.id
    ?? row.companyId
    ?? row.organizationId
    ?? row.linkedinId;
  const normalized = String(value || '').trim();
  return normalized && /^[A-Za-z0-9_-]{2,100}$/.test(normalized) ? normalized : null;
}

async function enrichOrganizationHeadcountViaApify({
  domain,
  name = null,
  linkedinUrl = null,
} = {}, options = {}) {
  const requestedDomain = normalizeDomain(domain);
  if (!requestedDomain) return safeFailure('domain_missing');

  const token = String(options.apiToken ?? process.env.APIFY_API_TOKEN ?? '').trim();
  if (!token) return safeFailure('not_configured');
  if (!options.httpClient && rejectedCredential === token) {
    return safeFailure('credential_rejected');
  }

  const directUrl = companyLinkedinUrl(linkedinUrl);
  const companyName = String(name || '').trim();
  if (!directUrl && !companyName) return safeFailure('organization_locator_missing');

  const maxItems = directUrl ? DIRECT_MAX_ITEMS : SEARCH_MAX_ITEMS;
  const maxTotalChargeUsd = directUrl ? DIRECT_MAX_CHARGE_USD : SEARCH_MAX_CHARGE_USD;
  const input = directUrl
    ? { companies: [directUrl] }
    : { searches: [companyName] };
  const client = options.httpClient || axios;

  let response;
  try {
    // This is intentionally one attempt. Retrying a billable synchronous Actor
    // after an ambiguous network failure could charge twice for one lookup.
    response = await client.post(ENDPOINT, input, {
      params: {
        token,
        timeout: Math.floor(TIMEOUT_MS / 1000),
        maxItems,
        maxTotalChargeUsd,
      },
      timeout: TIMEOUT_MS + 10_000,
      headers: { 'content-type': 'application/json' },
    });
  } catch (error) {
    const status = Number(error.response?.status || error.status || 0) || null;
    if (status === 401 || status === 403) {
      if (!options.httpClient) rejectedCredential = token;
      return safeFailure(status === 401 ? 'credential_rejected' : 'scope_rejected', {
        status,
        attempted: true,
      });
    }
    if (status === 402) return safeFailure('spend_limit_reached', { status, attempted: true });
    if (status === 404 || status === 422) {
      return safeFailure('organization_not_found', { status, attempted: true });
    }
    return safeFailure('provider_unavailable', { retryable: true, status, attempted: true });
  }

  const rows = Array.isArray(response?.data) ? response.data : [];
  if (!rows.length) {
    return safeFailure('organization_not_found', {
      status: response?.status || null,
      attempted: true,
    });
  }

  const matchingRows = rows.filter((row) => responseDomain(row) === requestedDomain);
  if (matchingRows.length !== 1) {
    return safeFailure(matchingRows.length ? 'ambiguous_domain_match' : 'domain_mismatch', {
      status: response?.status || null,
      attempted: true,
    });
  }

  const row = matchingRows[0];
  const count = responseEmployeeCount(row);
  const id = organizationId(row);
  const evidence = acceptProviderEmployeeEvidence({
    count,
    source: id ? `apify:organization:harvestapi-linkedin-company:${id}` : null,
    confidence: 0.85,
    provider: 'apify',
    domainMatched: true,
  });
  if (!evidence) {
    return safeFailure('employee_count_unavailable', {
      status: response?.status || null,
      attempted: true,
    });
  }

  try {
    if (!options.httpClient) {
      const estimatedCostUsd = Number(process.env.APIFY_LINKEDIN_COMPANY_COST_USD
        || (directUrl ? 0.00405 : 0.01205));
      require('../core/ai-safety/usage-tracker').recordUsage({
        provider: 'apify',
        model: ACTOR_SLUG,
        operationType: 'company_headcount_enrichment',
        estimatedCostUsd,
        isAutomated: true,
        requestSource: 'integrations/apify-organization.js:enrichOrganizationHeadcountViaApify',
      }).catch(() => {});
    }
  } catch (_) { /* evidence lookup must not depend on usage telemetry */ }

  return {
    ok: true,
    evidence,
    provider: 'apify',
    status: response?.status || 200,
    attempted: true,
    lookup: directUrl ? 'company_url' : 'name_search_domain_verified',
  };
}

function resetCredentialCacheForTest() {
  rejectedCredential = null;
}

module.exports = {
  enrichOrganizationHeadcountViaApify,
  companyLinkedinUrl,
  _test: {
    responseDomain,
    responseEmployeeCount,
    organizationId,
    resetCredentialCacheForTest,
  },
};
