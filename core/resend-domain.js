/**
 * Growth OS — Resend Domain Helper
 *
 * When a tenant enables the Prospecting module, their outbound cold
 * emails come from a tenant-specific domain (e.g.
 * outreach.<their-domain>.com) so we don't burn FGA's primary domain
 * reputation. This helper:
 *   1. Creates the domain in Resend's API
 *   2. Pulls the DNS records (SPF + DKIM + return-path) Resend issues
 *   3. Drafts an email to the tenant owner with copy-paste DNS rows
 *   4. Polls verification status (caller decides cadence)
 *
 * Lazy-fires from the asset-gen worker when tenant_modules.prospecting
 * is enabled. Idempotent — checks for existing tenant_config
 * resend_domain_id before creating.
 *
 * RESEND_API_KEY env var is the platform-level key (same one that
 * sends transactional emails). Resend lets one account own many
 * domains, so this scales without per-tenant Resend accounts.
 */

const axios = require('axios');
const { createLogger } = require('./logger');
const { getServiceClient } = require('../db/client');

const RESEND_API_BASE = 'https://api.resend.com';
const log = createLogger('resend-domain');

function authHeaders() {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY is required');
  return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
}

/**
 * Create a Resend domain or look up existing one by name.
 * @param {string} domainName - e.g. "outreach.atlantatreepros.com"
 * @returns {Promise<{id, name, dnsRecords}>} from Resend
 */
async function ensureResendDomain(domainName) {
  if (!domainName) throw new Error('domainName is required');

  // Check existing domains first (idempotency)
  const listRes = await axios.get(`${RESEND_API_BASE}/domains`, { headers: authHeaders() });
  const existing = (listRes.data?.data || []).find((d) => d.name === domainName);
  if (existing) {
    log.info(`Domain ${domainName} already exists in Resend (id: ${existing.id})`);
    // Fetch full detail (DNS records aren't in list response)
    const detail = await axios.get(`${RESEND_API_BASE}/domains/${existing.id}`, { headers: authHeaders() });
    return detail.data;
  }

  // Create new
  log.info(`Creating Resend domain: ${domainName}`);
  const createRes = await axios.post(
    `${RESEND_API_BASE}/domains`,
    { name: domainName, region: 'us-east-1' },
    { headers: authHeaders() },
  );
  return createRes.data;
}

async function getDomainStatus(domainId) {
  const res = await axios.get(`${RESEND_API_BASE}/domains/${domainId}`, { headers: authHeaders() });
  return res.data;
}

async function triggerDomainVerification(domainId) {
  const res = await axios.post(`${RESEND_API_BASE}/domains/${domainId}/verify`, {}, { headers: authHeaders() });
  return res.data;
}

/**
 * Format DNS records as a copy-paste table for the customer.
 * They take this to their DNS provider (GoDaddy, Cloudflare, etc.)
 * and add each row.
 */
function formatDnsInstructions(domain) {
  const records = domain.records || [];
  if (!records.length) return 'No DNS records returned yet — refresh in a moment.';

  const lines = [
    'Add these DNS records to your domain provider (GoDaddy, Cloudflare, Namecheap, etc.):',
    '',
  ];
  for (const r of records) {
    lines.push(`  TYPE: ${r.record || r.type}`);
    lines.push(`  NAME: ${r.name}`);
    lines.push(`  VALUE: ${r.value}`);
    if (r.priority !== undefined) lines.push(`  PRIORITY: ${r.priority}`);
    if (r.ttl !== undefined) lines.push(`  TTL: ${r.ttl || 'Auto'}`);
    lines.push('');
  }
  lines.push('Most DNS providers propagate within 15 minutes but allow up to 24 hours.');
  return lines.join('\n');
}

/**
 * Full provisioning flow for a tenant's Resend domain. Stores the
 * domain id + DNS instructions in tenant_config and (optionally)
 * emails the owner with copy-paste DNS rows.
 *
 * @param {Object} args
 * @param {string} args.tenantId
 * @param {string} args.domainName
 * @param {string} [args.ownerEmail] - if set, sends a how-to email
 * @returns {Promise<Object>}
 */
async function provisionTenantResendDomain({ tenantId, domainName, ownerEmail }) {
  if (!tenantId) throw new Error('tenantId is required');
  const db = getServiceClient();

  const domain = await ensureResendDomain(domainName);
  const instructions = formatDnsInstructions(domain);

  await db.from('tenant_config').upsert(
    [
      { tenant_id: tenantId, key: 'resend_domain_id', value: domain.id },
      { tenant_id: tenantId, key: 'resend_domain_name', value: domain.name },
      { tenant_id: tenantId, key: 'resend_domain_status', value: domain.status || 'pending' },
      { tenant_id: tenantId, key: 'resend_dns_records', value: domain.records || [] },
      { tenant_id: tenantId, key: 'resend_dns_instructions', value: instructions },
      { tenant_id: tenantId, key: 'resend_domain_provisioned_at', value: new Date().toISOString() },
    ],
    { onConflict: 'tenant_id,key' },
  );

  log.success(`Tenant ${tenantId} → Resend domain ${domainName} ready (status: ${domain.status || 'pending'})`);

  // Best-effort: email the owner with the DNS rows
  if (ownerEmail) {
    try {
      const emailMod = require('../integrations/email');
      await emailMod.sendEmail(
        ownerEmail,
        `Action required: add ${domainName} DNS records for FGA outreach`,
        `<pre style="font-family:monospace;font-size:13px;line-height:1.5;">${instructions.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>`,
      );
      log.info(`DNS-instructions email sent to ${ownerEmail}`);
    } catch (emailErr) {
      log.warn(`DNS-instructions email failed (non-fatal): ${emailErr.message}`);
    }
  }

  return { domainId: domain.id, name: domain.name, status: domain.status, records: domain.records };
}

module.exports = {
  ensureResendDomain,
  getDomainStatus,
  triggerDomainVerification,
  formatDnsInstructions,
  provisionTenantResendDomain,
};
