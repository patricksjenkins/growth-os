/**
 * Growth OS — Cloudflare Integration
 *
 * Handles two Cloudflare services for the DFY Website module:
 *
 * 1. Cloudflare Pages — deploy static sites per tenant (free tier,
 *    unlimited sites, unlimited bandwidth, automatic SSL).
 * 2. Cloudflare Registrar — register .com domains for customers at
 *    wholesale (~$10/yr), absorbed in the $1K setup fee.
 *
 * Both use Cloudflare's REST API v4.
 * Required env vars: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID
 *
 * The API token needs these permissions:
 *   - Account > Cloudflare Pages > Edit
 *   - Account > Registrar > Edit (for domain registration)
 *   - Zone > DNS > Edit (for custom domain binding)
 */

const { createLogger } = require('../core/logger');

const CF_API = 'https://api.cloudflare.com/client/v4';

function headers() {
  return {
    Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

function accountId() {
  const id = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!id) throw new Error('CLOUDFLARE_ACCOUNT_ID not set');
  return id;
}

async function cfFetch(path, opts = {}) {
  const url = `${CF_API}${path}`;
  const res = await fetch(url, { headers: headers(), ...opts });
  const json = await res.json();
  if (!json.success) {
    const msgs = (json.errors || []).map((e) => e.message).join('; ');
    throw new Error(`Cloudflare API error: ${msgs || res.statusText}`);
  }
  return json.result;
}

// ─── Pages ───────────────────────────────────────────────────────────

/**
 * Create a Cloudflare Pages project for a tenant.
 * @param {string} projectName — URL-safe slug, e.g. "jenkins-plumbing"
 * @returns {Object} Pages project metadata
 */
async function createPagesProject(projectName) {
  const log = createLogger('cloudflare', projectName);
  log.info(`Creating Pages project: ${projectName}`);

  const result = await cfFetch(`/accounts/${accountId()}/pages/projects`, {
    method: 'POST',
    body: JSON.stringify({
      name: projectName,
      production_branch: 'main',
    }),
  });
  log.success(`Pages project created: ${result.name}`);
  return result;
}

/**
 * Deploy a bundle of static files to Cloudflare Pages.
 * Uses the Direct Upload API — no git repo required.
 *
 * @param {string} projectName — existing Pages project name
 * @param {Buffer|FormData} formData — multipart form with files
 * @returns {Object} Deployment result with url
 */
async function deployToPages(projectName, formData) {
  const log = createLogger('cloudflare', projectName);
  log.info(`Deploying to Pages project: ${projectName}`);

  const url = `${CF_API}/accounts/${accountId()}/pages/projects/${projectName}/deployments`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` },
    body: formData,
  });
  const json = await res.json();
  if (!json.success) {
    const msgs = (json.errors || []).map((e) => e.message).join('; ');
    throw new Error(`Pages deploy failed: ${msgs}`);
  }
  log.success(`Deployed: ${json.result.url}`);
  return json.result;
}

/**
 * Bind a custom domain to a Pages project.
 * Requires the domain's zone to already exist in Cloudflare.
 *
 * @param {string} projectName — Pages project name
 * @param {string} domain — e.g. "www.jenkinsplumbing.com"
 */
async function addCustomDomain(projectName, domain) {
  const log = createLogger('cloudflare', projectName);
  log.info(`Binding custom domain ${domain} to project ${projectName}`);

  const result = await cfFetch(
    `/accounts/${accountId()}/pages/projects/${projectName}/domains`,
    {
      method: 'POST',
      body: JSON.stringify({ name: domain }),
    },
  );
  log.success(`Custom domain bound: ${domain}`);
  return result;
}

// ─── DNS / Zones ─────────────────────────────────────────────────────

/**
 * Add a domain to Cloudflare (creates a zone).
 * The domain doesn't need to be registered through CF — this works
 * for both CF-registered and externally-registered domains.
 *
 * @param {string} domain — e.g. "jenkinsplumbing.com"
 * @returns {Object} Zone result with id + name_servers
 */
async function addZone(domain) {
  const log = createLogger('cloudflare', domain);
  log.info(`Adding zone for ${domain}`);

  const result = await cfFetch('/zones', {
    method: 'POST',
    body: JSON.stringify({
      name: domain,
      account: { id: accountId() },
      type: 'full',
    }),
  });
  log.success(`Zone created: ${result.id} — nameservers: ${result.name_servers?.join(', ')}`);
  return result;
}

/**
 * Check if a domain's zone already exists in the account.
 * @param {string} domain
 * @returns {Object|null} Zone object or null
 */
async function findZone(domain) {
  const result = await cfFetch(`/zones?name=${encodeURIComponent(domain)}&account.id=${accountId()}`);
  // cfFetch returns the result array directly for list endpoints
  const zones = Array.isArray(result) ? result : [result];
  return zones.find((z) => z.name === domain) || null;
}

// ─── Registrar ───────────────────────────────────────────────────────

/**
 * Check domain availability for registration.
 * @param {string} domain — e.g. "jenkinsplumbing.com"
 * @returns {Object} { available: boolean, premium: boolean, price: number }
 */
async function checkDomainAvailability(domain) {
  const result = await cfFetch(
    `/accounts/${accountId()}/registrar/domains/check?domain=${encodeURIComponent(domain)}`,
  );
  return result;
}

/**
 * Register a domain through Cloudflare Registrar.
 * At-cost pricing: ~$10.11/yr for .com.
 * Domain is auto-added to the account's zones.
 *
 * @param {string} domain — e.g. "jenkinsplumbing.com"
 * @param {Object} contact — WHOIS contact details
 * @returns {Object} Registration result
 */
async function registerDomain(domain, contact = {}) {
  const log = createLogger('cloudflare', domain);
  log.info(`Registering domain: ${domain}`);

  // Cloudflare Registrar uses a specific contact shape
  const registrantContact = {
    first_name: contact.first_name || 'First Gen Automate',
    last_name: contact.last_name || 'LLC',
    organization: contact.organization || 'First Gen Automate LLC',
    address: contact.address || '123 Main St',
    city: contact.city || 'Atlanta',
    state: contact.state || 'GA',
    zip: contact.zip || '30301',
    country: contact.country || 'US',
    phone: contact.phone || '+1.0000000000',
    email: contact.email || 'domains@firstgenautomate.com',
  };

  const result = await cfFetch(`/accounts/${accountId()}/registrar/domains`, {
    method: 'POST',
    body: JSON.stringify({
      name: domain,
      auto_renew: true,
      locked: true,
      privacy: true,
      registrant: registrantContact,
    }),
  });
  log.success(`Domain registered: ${domain}`);
  return result;
}

module.exports = {
  createPagesProject,
  deployToPages,
  addCustomDomain,
  addZone,
  findZone,
  checkDomainAvailability,
  registerDomain,
};
