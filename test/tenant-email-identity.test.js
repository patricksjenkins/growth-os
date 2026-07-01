'use strict';

/**
 * Regression tests for the tenant email identity guardrails (P0 cross-tenant
 * bleed, 2026-07-01). Proves a non-platform tenant can never send with FGA
 * identity, and that missing/mismatched/bleeding sends are blocked.
 */

const test = require('node:test');
const assert = require('node:assert');
const {
  resolveIdentity, preflightOutbound, scanForbidden, signatureLinesFor,
  TenantIdentityError, isPlatformTenant,
} = require('../core/tenant-email-identity');

// --- fixtures ---
const FGA = { id: 'fga-id', slug: 'fga', name: 'First Gen Automate', config: {} };

const AKA = {
  id: 'aka-id', slug: 'a-kut-above', name: 'A Kut Above', config: {
    business_name: 'A Kut Above Tree Services',
    from_email: 'hello@akutabovetreeservices.com',
    from_name: 'A Kut Above Tree Services',
    reply_to: 'akutabove18@yahoo.com',
    contact_email: 'akutabove18@yahoo.com',
    sender_name: 'Shelia Jenkins',
    sender_title: 'A Kut Above Tree Services',
    sender_phone: '(228) 297-4366',
    sender_website: 'akutabovetreeservices.com',
    email_identity_verified: true,
  },
};

// AKA as it was DURING the incident: only business_name + owner_name.
const AKA_BROKEN = { id: 'aka-id', slug: 'a-kut-above', name: 'A Kut Above', config: { business_name: 'A Kut Above', owner_name: 'Shelia Jenkins' } };

const WELLMOR = {
  id: 'wm-id', slug: 'wellmor', name: 'WellMor', config: {
    business_name: 'WellMor Benefits', from_email: 'team@wellmor.com', from_name: 'WellMor Benefits',
    reply_to: 'hello@wellmor.com', sender_name: 'WellMor Team', sender_title: 'WellMor Benefits',
    sender_website: 'wellmor.com', email_identity_verified: true,
  },
};

const okBody = (biz) => `<p>Hi Linda, following up from ${biz}.</p><p>Shelia Jenkins<br>A Kut Above Tree Services</p>`;

// --- tenant identity resolution ---
test('AKA resolves to its OWN identity, never FGA', () => {
  const id = resolveIdentity(AKA);
  assert.strictEqual(id.from, 'A Kut Above Tree Services <hello@akutabovetreeservices.com>');
  assert.strictEqual(id.reply_to, 'akutabove18@yahoo.com');
  assert.ok(id.complete);
  const sig = signatureLinesFor(id).join('\n');
  assert.match(sig, /A Kut Above Tree Services/);
  assert.doesNotMatch(sig, /First Gen Automate/);
  assert.doesNotMatch(sig, /404/);
});

test('platform tenant (FGA) keeps FGA identity', () => {
  assert.ok(isPlatformTenant(FGA));
  const id = resolveIdentity(FGA);
  assert.match(id.from, /firstgenautomate\.com/);
  assert.ok(id.complete);
});

test('incident-state AKA (missing config) is INCOMPLETE, never FGA', () => {
  const id = resolveIdentity(AKA_BROKEN);
  assert.ok(!id.complete);
  assert.ok(id.missing.includes('from_email'));
  assert.ok(id.missing.includes('email_identity_verified'));
  assert.notStrictEqual(id.from, 'Patrick at First Gen Automate <patrick@firstgenautomate.com>');
  // signature must not contain FGA even when fields are missing
  assert.doesNotMatch(signatureLinesFor(id).join('\n'), /First Gen Automate|404/);
});

// --- preflight: customer sends ---
test('AKA customer follow-up sends with AKA identity', () => {
  const gate = preflightOutbound({ tenant: AKA, audience: 'customer', to: 'lead@x.com', subject: 'Following up — A Kut Above Tree Services', html: okBody('A Kut Above Tree Services'), ownership: { lead: { tenant_id: 'aka-id' } } });
  assert.strictEqual(gate.mode, 'customer');
  assert.match(gate.from, /akutabovetreeservices\.com/);
  assert.strictEqual(gate.replyTo, 'akutabove18@yahoo.com');
});

test('AKA review request + quote follow-up render AKA signature (no FGA)', () => {
  for (const subject of ['Thank you for choosing A Kut Above Tree Services', 'Your quote from A Kut Above Tree Services']) {
    const gate = preflightOutbound({ tenant: AKA, audience: 'customer', to: 'c@x.com', subject, html: okBody('A Kut Above Tree Services'), ownership: {} });
    assert.strictEqual(gate.replyTo, 'akutabove18@yahoo.com');
    assert.doesNotMatch(gate.signatureLines.join('\n'), /First Gen Automate/);
  }
});

test('BLOCK when tenant identity is missing/unverified', () => {
  assert.throws(
    () => preflightOutbound({ tenant: AKA_BROKEN, audience: 'customer', to: 'lead@x.com', subject: 'hi', html: '<p>hi</p>' }),
    (e) => e instanceof TenantIdentityError && e.code === 'TENANT_IDENTITY_INCOMPLETE',
  );
});

test('BLOCK when body contains FGA contact info (content scanner)', () => {
  const bleed = '<p>Hi Linda</p><p>Shelia Jenkins<br>Founder, First Gen Automate<br>(404) 496-7983 · firstgenautomate.com</p>';
  assert.throws(
    () => preflightOutbound({ tenant: AKA, audience: 'customer', to: 'lead@x.com', subject: 'Following up', html: bleed, ownership: {} }),
    (e) => e instanceof TenantIdentityError && e.code === 'CROSS_TENANT_CONTENT',
  );
});

test('BLOCK on job/lead/template tenant mismatch', () => {
  for (const key of ['lead', 'template', 'campaign', 'enrollment']) {
    assert.throws(
      () => preflightOutbound({ tenant: AKA, audience: 'customer', to: 'x@x.com', subject: 's', html: okBody('A Kut Above Tree Services'), ownership: { [key]: { tenant_id: 'someone-else' } } }),
      (e) => e instanceof TenantIdentityError && e.code === 'TENANT_OWNERSHIP_MISMATCH',
      `expected mismatch block for ${key}`,
    );
  }
});

test('another tenant cannot use AKA identity (no cross-tenant bleed)', () => {
  const gate = preflightOutbound({ tenant: WELLMOR, audience: 'customer', to: 'x@x.com', subject: 'Hello from WellMor', html: '<p>Hi from WellMor Benefits</p>', ownership: {} });
  assert.match(gate.from, /wellmor\.com/);
  assert.doesNotMatch(gate.from, /akutabove/);
  // and AKA contact info inside a WellMor email would be caught by the scanner
  assert.strictEqual(scanForbidden(resolveIdentity(WELLMOR), { html: 'reach me at akutabove18@yahoo.com', extraForbidden: ['akutabove18@yahoo.com'] }), 'akutabove18@yahoo.com');
});

// --- preflight: platform/owner sends still work ---
test('FGA outbound still uses FGA identity (not blocked)', () => {
  const gate = preflightOutbound({ tenant: FGA, audience: 'customer', to: 'prospect@x.com', subject: 'FGA', html: '<p>From First Gen Automate</p>' });
  assert.strictEqual(gate.mode, 'platform');
  assert.match(gate.from, /firstgenautomate\.com/);
});

test('owner/platform audience is lenient (onboarding/digests keep working)', () => {
  // AKA owner-facing email (e.g., a new-lead alert to the owner) is allowed and
  // prefers tenant identity, but is NOT blocked for FGA content rules.
  const gate = preflightOutbound({ tenant: AKA, audience: 'owner', to: 'akutabove18@yahoo.com', subject: 'New lead', html: '<p>You have a new lead</p>' });
  assert.notStrictEqual(gate.mode, 'customer');
});

test('clean AKA email passes the scanner', () => {
  assert.strictEqual(scanForbidden(resolveIdentity(AKA), { subject: 'Following up — A Kut Above Tree Services', html: okBody('A Kut Above Tree Services'), from: resolveIdentity(AKA).from, replyTo: 'akutabove18@yahoo.com' }), null);
});
