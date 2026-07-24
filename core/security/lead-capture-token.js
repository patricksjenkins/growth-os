'use strict';

const crypto = require('node:crypto');

function normalizeOrigin(value) {
  if (!value || typeof value !== 'string') return null;
  try {
    return new URL(value).origin.toLowerCase();
  } catch {
    return null;
  }
}

function captureSecret() {
  return process.env.LEAD_CAPTURE_SECRET || null;
}

function signature(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function signLeadCaptureToken({
  tenantId,
  origin,
  siteId,
  keyId = process.env.LEAD_CAPTURE_KEY_ID || 'v1',
  now = Date.now(),
  expiresInSeconds = 7 * 24 * 60 * 60,
}, secret = captureSecret()) {
  const normalizedOrigin = normalizeOrigin(origin);
  const issuedAt = Math.floor(Number(now) / 1000);
  if (!tenantId || !normalizedOrigin || !siteId || !keyId || !secret) {
    throw new Error('tenantId, siteId, keyId, valid origin, and LEAD_CAPTURE_SECRET are required');
  }
  if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 60 ||
      expiresInSeconds > 30 * 24 * 60 * 60 || !Number.isFinite(issuedAt)) {
    throw new Error('expiresInSeconds must be between 60 seconds and 30 days');
  }
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    kid: String(keyId),
    iat: issuedAt,
    exp: issuedAt + expiresInSeconds,
    tenant_id: tenantId,
    origin: normalizedOrigin,
    site_id: String(siteId),
  })).toString('base64url');
  return `${payload}.${signature(payload, secret)}`;
}

function verifyLeadCaptureToken(
  token,
  { tenantId, origin, siteId, now = Date.now(), expectedKeyId = process.env.LEAD_CAPTURE_KEY_ID || 'v1' },
  secret = captureSecret()
) {
  if (!token || typeof token !== 'string' || !secret) return { valid: false, reason: 'missing' };
  const [payload, supplied, extra] = token.split('.');
  if (!payload || !supplied || extra) return { valid: false, reason: 'malformed' };

  const expected = signature(payload, secret);
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
    return { valid: false, reason: 'signature' };
  }

  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { valid: false, reason: 'payload' };
  }

  const normalizedOrigin = normalizeOrigin(origin);
  const nowSeconds = Math.floor(Number(now) / 1000);
  if (
    claims.v !== 1 ||
    claims.kid !== expectedKeyId ||
    claims.tenant_id !== tenantId ||
    claims.origin !== normalizedOrigin ||
    claims.site_id !== siteId
  ) {
    return { valid: false, reason: 'binding' };
  }
  if (!Number.isInteger(claims.iat) || !Number.isInteger(claims.exp) ||
      claims.exp <= claims.iat || claims.exp - claims.iat > 30 * 24 * 60 * 60) {
    return { valid: false, reason: 'lifetime' };
  }
  if (!Number.isFinite(nowSeconds) || claims.iat > nowSeconds + 60) {
    return { valid: false, reason: 'issued_future' };
  }
  if (claims.exp <= nowSeconds) return { valid: false, reason: 'expired' };
  return {
    valid: true,
    claims: {
      version: 1,
      keyId: claims.kid,
      issuedAt: claims.iat,
      expiresAt: claims.exp,
      tenantId: claims.tenant_id,
      origin: claims.origin,
      siteId: claims.site_id,
    },
  };
}

module.exports = {
  normalizeOrigin,
  signLeadCaptureToken,
  verifyLeadCaptureToken,
};
