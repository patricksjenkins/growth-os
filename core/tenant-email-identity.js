/**
 * Tenant Email Identity — single source of truth + hard guardrails for who an
 * outbound email is "from", replies to, and signs as.
 *
 * WHY THIS EXISTS (P0 incident 2026-07-01): A Kut Above lead received a
 * follow-up email that shipped from `patrick@firstgenautomate.com`, replied to
 * FGA, and was signed "Founder, First Gen Automate". Root cause: every identity
 * path (integrations/email.js `from`/`reply_to`, the signature builders in
 * core/email-signature.js + worker agents) FELL BACK to FGA defaults when a
 * tenant hadn't configured its own. AKA only had business_name + owner_name, so
 * every AKA customer email rendered as FGA.
 *
 * The rule now: a NON-platform tenant's CUSTOMER-facing email may only send with
 * that tenant's own verified identity. If identity is missing/unverified, the
 * send is BLOCKED (failed_safe) — it never falls back to FGA. Platform/owner
 * emails (onboarding, digests, billing to the business owner) still use FGA.
 */

const { getConfig } = require('./config');

// The ONE place FGA (platform) identity strings live for both sending and
// forbidden-content detection.
const FGA_IDENTITY = {
  from: process.env.EMAIL_FROM || 'Patrick at First Gen Automate <patrick@firstgenautomate.com>',
  reply_to: process.env.EMAIL_REPLY_TO || 'patrick@firstgenautomate.com',
  business_name: 'First Gen Automate',
};

// Platform-identity tokens that must NEVER appear in a non-platform tenant's
// customer-facing email (subject/body/from/reply-to/signature). Lowercased.
const PLATFORM_FORBIDDEN_TOKENS = [
  'first gen automate',
  'firstgenautomate',            // covers firstgenautomate.com + patrick@firstgenautomate.com
  'founder, first gen automate',
  'patrick jenkins',
  '(404) 496-7983',
  '404-496-7983',
  '404.496.7983',
  '4044967983',
];

class TenantIdentityError extends Error {
  constructor(message, { code = 'TENANT_IDENTITY_BLOCKED', reason, tenantId, missing, violation } = {}) {
    super(message);
    this.name = 'TenantIdentityError';
    this.code = code;
    this.reason = reason || message;
    this.tenantId = tenantId;
    this.missing = missing;
    this.violation = violation;
    this.failedSafe = true; // signals callers/queue this was a safety block, not a transient error
  }
}

/** Is this the platform (FGA) tenant, for whom FGA identity is correct? */
function isPlatformTenant(tenant) {
  if (!tenant) return false;
  const slug = tenant.slug || '';
  const platformSlug = process.env.PLATFORM_TENANT_SLUG || 'fga';
  const platformId = process.env.FGA_TENANT_ID; // only trust an explicitly-set id
  return slug === platformSlug
    || (platformId && String(tenant.id) === String(platformId))
    || tenant.is_platform === true
    || (tenant.config && (tenant.config.is_platform === true || tenant.config.is_platform === 'true'));
}

/** Format a display From header from a name + email (idempotent if already "Name <email>"). */
function formatFrom(name, email) {
  if (!email) return null;
  if (email.includes('<')) return email; // already "Name <email>"
  return name ? `${name} <${email}>` : email;
}

/**
 * Resolve a tenant's email identity from config. NO FGA fallback for
 * non-platform tenants — missing fields are reported in `missing`.
 * @param {Object} tenant — resolved tenant (must have .config for real data)
 */
function resolveIdentity(tenant) {
  const g = (k, d) => getConfig(tenant, k, d);

  if (isPlatformTenant(tenant)) {
    return {
      tenant_id: tenant.id,
      platform: true,
      business_name: g('business_name', 'First Gen Automate'),
      from_name: 'Patrick at First Gen Automate',
      from_email: 'patrick@firstgenautomate.com',
      from: FGA_IDENTITY.from,
      reply_to: FGA_IDENTITY.reply_to,
      contact_email: 'patrick@firstgenautomate.com',
      contact_phone: '(404) 496-7983',
      website_url: 'firstgenautomate.com',
      provider: 'resend',
      sending_domain_status: 'verified',
      verified: true,
      signature: {
        name: g('sender_name', 'Patrick Jenkins'),
        title: g('sender_title', 'Founder, First Gen Automate'),
        business: 'First Gen Automate',
        phone: g('sender_phone', '(404) 496-7983'),
        website: g('sender_website', 'firstgenautomate.com'),
        email: 'patrick@firstgenautomate.com',
      },
      missing: [],
      complete: true,
    };
  }

  const business = g('business_name', tenant.name || null);
  const fromEmail = g('from_email', null);
  const fromName = g('from_name', business);
  const replyTo = g('reply_to', null) || g('reply_to_email', null) || g('support_email', null) || g('contact_email', null);
  const website = g('sender_website', null) || g('website_url', null) || g('website', null);
  const verifiedRaw = g('email_identity_verified', false);
  const verified = verifiedRaw === true || verifiedRaw === 'true';

  const signature = {
    name: g('sender_name', null) || g('owner_name', null),
    title: g('sender_title', null),         // NO FGA fallback
    business: business,
    phone: g('sender_phone', null) || g('contact_phone', null),
    website,
    email: g('sender_email', null) || replyTo,
  };

  const missing = [];
  if (!business) missing.push('business_name');
  if (!fromEmail) missing.push('from_email');
  if (!replyTo) missing.push('reply_to');
  if (!signature.name) missing.push('signature_name');
  if (!verified) missing.push('email_identity_verified');

  return {
    tenant_id: tenant.id,
    platform: false,
    business_name: business,
    from_name: fromName,
    from_email: fromEmail,
    from: formatFrom(fromName, fromEmail),
    reply_to: replyTo,
    contact_email: g('contact_email', replyTo),
    contact_phone: signature.phone,
    website_url: website,
    provider: g('email_provider', 'resend'),
    sending_domain_status: g('sending_domain_status', verified ? 'verified' : 'unverified'),
    verified,
    signature,
    missing,
    complete: missing.length === 0,
  };
}

/** Tenant-scoped signature lines (plain text). Never FGA for non-platform. */
function signatureLinesFor(identity) {
  const s = identity.signature || {};
  const contact = [s.phone, s.website].filter(Boolean).join(' · ');
  // name, then business/title, then contact — drop any missing line.
  return [s.name, s.title || s.business, contact].filter(Boolean);
}

/** Strings that legitimately belong to THIS tenant — never flagged as bleed. */
function allowedTermsFor(identity) {
  return [
    identity.business_name, identity.from_email, identity.reply_to, identity.contact_email,
    identity.website_url, identity.contact_phone, identity.from_name,
    identity.signature && identity.signature.name,
  ].filter(Boolean).map((s) => String(s).toLowerCase());
}

/**
 * Scan an outbound customer email for cross-tenant / platform bleed.
 * Returns the offending token, or null if clean.
 */
function scanForbidden(identity, { subject = '', html = '', text = '', from = '', replyTo = '', extraForbidden = [] } = {}) {
  const haystack = [subject, html, text, from, replyTo].join(' \n ').toLowerCase();
  const allowed = allowedTermsFor(identity);
  const tokens = [...PLATFORM_FORBIDDEN_TOKENS, ...extraForbidden.map((t) => String(t).toLowerCase())];
  for (const tok of tokens) {
    if (!tok) continue;
    if (allowed.some((a) => a.includes(tok))) continue; // belongs to this tenant
    if (haystack.includes(tok)) return tok;
  }
  return null;
}

/**
 * Assert every related record belongs to the same tenant as the send job.
 * Each entry may be undefined (skipped) or an object with a tenant_id.
 */
function assertOwnership(tenantId, ownership = {}) {
  for (const [label, rec] of Object.entries(ownership)) {
    if (!rec) continue;
    const rid = rec.tenant_id || rec.tenantId;
    if (rid && String(rid) !== String(tenantId)) {
      throw new TenantIdentityError(
        `Cross-tenant ${label} mismatch: ${label}.tenant_id (${rid}) != job.tenant_id (${tenantId})`,
        { code: 'TENANT_OWNERSHIP_MISMATCH', tenantId, reason: `${label} belongs to a different tenant` },
      );
    }
  }
}

/**
 * The preflight gate. For CUSTOMER audience on a non-platform tenant it either
 * returns the safe {from, replyTo, identity} to use, or THROWS TenantIdentityError.
 * For platform/owner audiences it returns FGA-or-provided identity (lenient).
 *
 * @returns {{ from, replyTo, mode, identity, signatureLines }}
 */
function preflightOutbound({ tenant, audience, to, subject, html, text, from, replyTo, ownership }) {
  const platform = isPlatformTenant(tenant);
  const mode = platform ? 'platform' : (audience || 'owner');

  if (mode !== 'customer') {
    // Platform / owner-facing (onboarding, digests, billing). FGA identity ok.
    const id = resolveIdentity(tenant);
    return {
      mode,
      identity: id,
      from: from || (platform ? FGA_IDENTITY.from : (id.from || FGA_IDENTITY.from)),
      replyTo: replyTo || (platform ? FGA_IDENTITY.reply_to : (id.reply_to || FGA_IDENTITY.reply_to)),
      signatureLines: signatureLinesFor(id),
    };
  }

  // CUSTOMER audience on a non-platform tenant — hard enforcement.
  const identity = resolveIdentity(tenant);

  // Guardrail 4: ownership assertions.
  assertOwnership(tenant.id, ownership || {});

  // Guardrail 1 + 2: identity must exist and be verified. No FGA fallback.
  if (!identity.complete) {
    throw new TenantIdentityError('Tenant email identity missing or unverified', {
      code: 'TENANT_IDENTITY_INCOMPLETE',
      tenantId: tenant.id,
      missing: identity.missing,
      reason: `Missing/unverified: ${identity.missing.join(', ')}`,
    });
  }

  // Guardrail 3: cross-tenant / platform content scanner.
  const violation = scanForbidden(identity, { subject, html, text, from: identity.from, replyTo: identity.reply_to });
  if (violation) {
    throw new TenantIdentityError(`Cross-tenant content detected in email ("${violation}")`, {
      code: 'CROSS_TENANT_CONTENT',
      tenantId: tenant.id,
      violation,
      reason: `Body/subject contains forbidden identity: "${violation}"`,
    });
  }

  // Guardrail 7: provider must be an allowed sending provider.
  if (identity.provider && identity.provider !== 'resend') {
    throw new TenantIdentityError(`Sending provider "${identity.provider}" not allowed`, {
      code: 'PROVIDER_NOT_ALLOWED', tenantId: tenant.id,
    });
  }

  return {
    mode: 'customer',
    identity,
    from: identity.from,        // tenant identity ONLY — never FGA
    replyTo: identity.reply_to, // tenant reply-to ONLY — never FGA
    signatureLines: signatureLinesFor(identity),
  };
}

module.exports = {
  FGA_IDENTITY,
  PLATFORM_FORBIDDEN_TOKENS,
  TenantIdentityError,
  isPlatformTenant,
  resolveIdentity,
  signatureLinesFor,
  scanForbidden,
  assertOwnership,
  preflightOutbound,
  formatFrom,
};
