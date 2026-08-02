/**
 * Growth OS — Webhook Verification Middleware
 * Verifies signatures from Calendly and Buffer.
 */

const crypto = require('crypto');
const { createLogger } = require('../../core/logger');
const { flags } = require('../../core/autonomous-os/feature-flags');

const log = createLogger('webhook');

/**
 * Verify Calendly webhook signature
 */
function verifyCalendlySignature(req, res, next) {
  const signature = req.headers['calendly-webhook-signature'];
  if (!signature) {
    if (flags.strictWebhookVerification()) {
      return res.status(403).json({ error: 'Missing Calendly signature' });
    }
    log.warn('No Calendly signature — allowing for now');
    return next();
  }

  // Calendly signature verification requires the webhook signing key
  // This will be stored in tenant_integrations.calendly.credentials.webhook_secret
  const secret = req.tenant?.integrations?.calendly?.credentials?.webhook_secret;
  if (!secret) {
    if (flags.strictWebhookVerification()) {
      return res.status(503).json({ error: 'Webhook verification unavailable' });
    }
    return next(); // No secret configured, allow through
  }

  const body = JSON.stringify(req.body);
  const computed = crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('hex');

  const expected = Buffer.from(computed);
  const supplied = Buffer.from(signature);
  if (expected.length !== supplied.length ||
      !crypto.timingSafeEqual(expected, supplied)) {
    return res.status(403).json({ error: 'Invalid Calendly signature' });
  }

  next();
}

module.exports = { verifyCalendlySignature };
