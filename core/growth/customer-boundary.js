'use strict';

const { FGA_TENANT_ID } = require('../config');
const { normalizeEmail, normalizeDomain, normalizeName } = require('./suppression');

const PUBLIC_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'outlook.com', 'hotmail.com',
  'live.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com',
  'msn.com', 'comcast.net', 'att.net', 'bellsouth.net',
]);

function businessDomain(emailOrDomain) {
  const value = String(emailOrDomain || '').trim().toLowerCase();
  const domain = normalizeDomain(value.includes('@') ? value.split('@').at(-1) : value);
  return domain && !PUBLIC_EMAIL_DOMAINS.has(domain) ? domain : null;
}

function companyKey(value) {
  return String(normalizeName(value || '') || '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(llc|inc|corp|corporation|company|co)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function createProtectedOrganizationIndex({
  customerRows = [], tenantRows = [], tenantUserRows = [], websiteRows = [],
} = {}) {
  const emails = new Set();
  const domains = new Set();
  const companies = new Set();
  const protectedTenantIds = new Set(
    tenantRows
      .filter((row) => row.id !== FGA_TENANT_ID && row.is_demo !== true)
      .map((row) => row.id),
  );

  const addEmail = (value) => {
    const email = normalizeEmail(value);
    if (email) emails.add(email);
    const domain = businessDomain(email);
    if (domain) domains.add(domain);
  };
  const addCompany = (value) => {
    const key = companyKey(value);
    if (key.length >= 3) companies.add(key);
  };

  for (const row of customerRows) {
    addEmail(row.email);
    addCompany(row.name);
  }
  for (const row of tenantRows) {
    if (!protectedTenantIds.has(row.id)) continue;
    addEmail(row.owner_email);
    addCompany(row.name);
    addCompany(row.slug);
  }
  for (const row of tenantUserRows) {
    if (protectedTenantIds.has(row.tenant_id)) addEmail(row.email);
  }
  for (const row of websiteRows) {
    if (!protectedTenantIds.has(row.tenant_id)) continue;
    const domain = businessDomain(row.domain);
    if (domain) domains.add(domain);
    // A platform subdomain is not an organization identity boundary.
  }

  return Object.freeze({ emails, domains, companies });
}

function matchProtectedOrganization(index, { email, companyName } = {}) {
  const normalizedEmail = normalizeEmail(email);
  const domain = businessDomain(normalizedEmail);
  const company = companyKey(companyName);
  if (normalizedEmail && index.emails.has(normalizedEmail)) {
    return { protected: true, reason: 'protected_email' };
  }
  if (domain && index.domains.has(domain)) {
    return { protected: true, reason: 'protected_domain' };
  }
  if (company && index.companies.has(company)) {
    return { protected: true, reason: 'protected_company' };
  }
  return { protected: false };
}

async function loadProtectedOrganizationIndex(db) {
  const [customers, tenants, tenantUsers, websites] = await Promise.all([
    db.from('customers').select('id, name, email').eq('tenant_id', FGA_TENANT_ID).limit(1000),
    db.from('tenants').select('id, name, slug, owner_email, is_demo').limit(1000),
    db.from('tenant_users').select('tenant_id, email').limit(5000),
    db.from('tenant_websites').select('tenant_id, domain, subdomain').limit(1000),
  ]);
  for (const [label, result] of Object.entries({ customers, tenants, tenantUsers, websites })) {
    if (result.error) throw new Error(`protected_organization_${label}_failed:${result.error.message}`);
  }
  return createProtectedOrganizationIndex({
    customerRows: customers.data || [],
    tenantRows: tenants.data || [],
    tenantUserRows: tenantUsers.data || [],
    websiteRows: websites.data || [],
  });
}

module.exports = {
  PUBLIC_EMAIL_DOMAINS,
  businessDomain,
  companyKey,
  createProtectedOrganizationIndex,
  matchProtectedOrganization,
  loadProtectedOrganizationIndex,
};
