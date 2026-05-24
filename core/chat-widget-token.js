/**
 * Growth OS — Chat widget token helper
 *
 * V1 hardening (2026-05-24). Single source of truth for the HMAC scheme
 * the embeddable chat widget uses to prove its tenant_id wasn't spoofed.
 *
 * Both sides share this module so the verify path (api/routes/chat.js)
 * and the mint path (worker/agents/dfy-website-build.js) can never drift.
 * The DFY build pipeline calls signWidgetToken() once per customer site,
 * embeds the token as data-widget-token on the <script> tag, and the
 * widget includes it in the POST body. The chat route verifies via
 * verifyWidgetToken().
 *
 * Token formula:
 *   base64url( HMAC-SHA256(tenant_id) )  keyed off CHAT_WIDGET_SECRET
 *
 * The token is NOT time-limited: it ships embedded in a static HTML page
 * and would invalidate every site on a key rotation, which is heavy.
 * Compensating control: the secret is server-only, and the chat endpoint
 * still rate-limits per IP + per-tenant cap.
 */

const crypto = require('crypto');

function getWidgetSecret() {
  // Same fallback chain as api/routes/chat.js — keeps the two paths in sync.
  return process.env.CHAT_WIDGET_SECRET
    || process.env.SUPABASE_SERVICE_ROLE_KEY
    || 'INSECURE_FALLBACK_DO_NOT_USE_IN_PROD';
}

/**
 * Mint the widget token for a tenant. Used by the DFY website-build
 * agent + any other surface that needs to embed the token in a
 * customer-facing page.
 *
 * @param {string} tenantId — the customer tenant's UUID
 * @returns {string} base64url-encoded HMAC-SHA256
 */
function signWidgetToken(tenantId) {
  if (!tenantId || typeof tenantId !== 'string') {
    throw new Error('signWidgetToken: tenantId required');
  }
  return crypto
    .createHmac('sha256', getWidgetSecret())
    .update(tenantId)
    .digest('base64url');
}

/**
 * Verify a widget token against the expected HMAC for the tenant.
 * Constant-time compare via crypto.timingSafeEqual.
 *
 * @param {string} token — value submitted by the widget
 * @param {string} tenantId — tenant_id the widget claims to represent
 * @returns {boolean}
 */
function verifyWidgetToken(token, tenantId) {
  if (typeof token !== 'string' || !token) return false;
  let expected;
  try { expected = signWidgetToken(tenantId); }
  catch { return false; }
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { signWidgetToken, verifyWidgetToken, getWidgetSecret };
