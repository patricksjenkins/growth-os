/**
 * Growth OS — Meta Conversions API (CAPI) Integration
 *
 * Server-side companion to the Meta Pixel installed on the
 * marketing site. Fires Purchase events from the Stripe webhook
 * so ad performance measurement survives:
 *   - Adblockers that strip the browser Pixel
 *   - iOS Safari ITP / Private Relay
 *   - Tab-close-before-success-page-loads
 *
 * Browser Pixel + this server-side CAPI event use the SAME
 * event_id (passed from marketing-site → Stripe Payment Link
 * client_reference_id → Stripe Checkout Session → here). Meta
 * de-duplicates the pair, so we never double-count.
 *
 * Required env vars (both set in Railway → growth-os service):
 *   META_PIXEL_ID    — 16-digit dataset/pixel ID (NOT a secret)
 *   META_CAPI_TOKEN  — server access token (TREAT LIKE A PASSWORD)
 *
 * If either is missing, sendPurchaseEvent() logs a warning and
 * returns without throwing — Stripe webhook processing is NEVER
 * blocked on ad-measurement failures.
 */

const crypto = require('crypto');
const { createLogger } = require('../core/logger');
const { withRetry } = require('./_retry');

const log = createLogger('meta-capi');

const API_VERSION = 'v18.0';

/**
 * SHA-256 hash a string per Meta's spec: lowercase + trim first.
 * Returns undefined for empty/null input (so we don't ship a hash
 * of the empty string as if it were a real user identifier).
 */
function sha256(value) {
  if (value === null || value === undefined) return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return undefined;
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/**
 * Hash a phone number — same as sha256 but also strips non-digits
 * first per Meta's spec (e.g. "+1 (404) 555-1212" → "14045551212").
 */
function sha256Phone(value) {
  if (!value) return undefined;
  const digits = String(value).replace(/\D/g, '');
  if (!digits) return undefined;
  return crypto.createHash('sha256').update(digits).digest('hex');
}

/**
 * Send a Purchase event to Meta CAPI.
 *
 * @param {Object} args
 * @param {string} args.eventId       Same UUID the browser Pixel used (for dedup)
 * @param {number} args.value         Dollar amount (e.g. 199 for setup fee, 249 for Growth monthly)
 * @param {string} [args.currency]    Defaults to 'USD'
 * @param {string} [args.email]       Plain email — will be hashed here
 * @param {string} [args.phone]       Plain phone — will be hashed here
 * @param {string} [args.fbp]         _fbp cookie (passed from browser via Stripe metadata)
 * @param {string} [args.fbc]         _fbc cookie (passed from browser via Stripe metadata)
 * @param {string} [args.sourceUrl]   The URL the user clicked from (e.g. https://firstgenautomate.com/pricing)
 * @param {string} [args.testEventCode]  Optional Meta Test Events code (TEST12345 etc.) — STRIP before going live
 * @returns {Promise<{ok: boolean, skipped?: string, error?: string}>}
 */
async function sendPurchaseEvent(args) {
  const pixelId = process.env.META_PIXEL_ID;
  const token = process.env.META_CAPI_TOKEN;

  if (!pixelId || !token) {
    log.warn('META_PIXEL_ID or META_CAPI_TOKEN not set — skipping Purchase event');
    return { ok: false, skipped: 'env_missing' };
  }
  if (!args || !args.eventId || !args.value) {
    log.warn('sendPurchaseEvent called without eventId or value — skipping');
    return { ok: false, skipped: 'bad_args' };
  }

  const userData = {};
  const hashedEmail = sha256(args.email);
  const hashedPhone = sha256Phone(args.phone);
  if (hashedEmail) userData.em = [hashedEmail];
  if (hashedPhone) userData.ph = [hashedPhone];
  if (args.fbp) userData.fbp = args.fbp;
  if (args.fbc) userData.fbc = args.fbc;

  // Meta requires at least one user identifier. If we have none (very
  // unlikely — Stripe always gives us email), log and bail rather than
  // fire an unmatched event that hurts the dataset quality score.
  if (Object.keys(userData).length === 0) {
    log.warn(`No user_data identifiers for event ${args.eventId} — skipping`);
    return { ok: false, skipped: 'no_user_data' };
  }

  const payload = {
    data: [
      {
        event_name: 'Purchase',
        event_time: Math.floor(Date.now() / 1000),
        event_id: args.eventId,
        action_source: 'website',
        event_source_url: args.sourceUrl,
        user_data: userData,
        custom_data: {
          currency: args.currency || 'USD',
          value: Number(args.value),
        },
      },
    ],
    access_token: token,
  };
  if (args.testEventCode) {
    payload.test_event_code = args.testEventCode;
  }

  const url = `https://graph.facebook.com/${API_VERSION}/${pixelId}/events`;

  try {
    const body = await withRetry(
      async () => {
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const text = await resp.text();
        if (!resp.ok) {
          const err = new Error(`Meta CAPI ${resp.status}: ${text.slice(0, 400)}`);
          err.status = resp.status;
          throw err;
        }
        return text ? JSON.parse(text) : {};
      },
      {
        attempts: 3,
        onRetry: (err, attempt, delayMs) =>
          log.warn(`Meta CAPI retry ${attempt} in ${delayMs}ms: ${err.message}`),
      },
    );
    log.info(
      `Meta CAPI Purchase ok event_id=${args.eventId} value=${args.value} ` +
        `events_received=${body.events_received || 0}`,
    );
    return { ok: true };
  } catch (err) {
    // We deliberately swallow the error rather than throwing — ad
    // measurement is never allowed to block a webhook ack to Stripe.
    log.error(`Meta CAPI Purchase failed event_id=${args.eventId}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

module.exports = {
  sendPurchaseEvent,
  // Exported for unit tests
  _internal: { sha256, sha256Phone },
};
