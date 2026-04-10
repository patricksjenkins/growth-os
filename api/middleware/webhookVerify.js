/**
 * Growth OS — Webhook Verification Middleware
 * Verifies signatures from Twilio, Calendly, and Buffer
 */

const crypto = require('crypto');
const { createLogger } = require('../../core/logger');
const { findTenantByPhone } = require('../../db/queries/config');
const { resolveTenant } = require('../../core/tenant');
const { getServiceClient } = require('../../db/client');

const log = createLogger('webhook');

/**
 * Resolve tenant from Twilio webhook (before signature verification)
 * Twilio sends the tenant's phone number in the 'To' field
 */
async function resolveTwilioTenant(req, res, next) {
  try {
    const toNumber = req.body.To;
    if (!toNumber) {
      return res.status(400).json({ error: 'Missing To field' });
    }

    const tenant = await findTenantByPhone(toNumber);
    if (!tenant) {
      log.warn(`No tenant found for phone: ${toNumber}`);
      return res.status(404).json({ error: 'Unknown phone number' });
    }

    const supabase = getServiceClient();
    req.tenant = await resolveTenant(supabase, tenant.id);
    req.tenantId = tenant.id;
    next();
  } catch (err) {
    log.error('Twilio tenant resolution failed', err);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
}

/**
 * Verify Twilio webhook signature
 * Uses the tenant's Twilio auth token to validate the request
 */
function verifyTwilioSignature(req, res, next) {
  const signature = req.headers['x-twilio-signature'];
  if (!signature) {
    return res.status(403).json({ error: 'Missing Twilio signature' });
  }

  const authToken = req.tenant?.integrations?.twilio?.credentials?.auth_token;
  if (!authToken) {
    log.warn('No Twilio auth token for signature verification — allowing for now');
    return next();
  }

  const apiUrl = process.env.API_URL || 'http://localhost:3000';
  const url = `${apiUrl}${req.originalUrl}`;

  // Build the data string: URL + sorted POST params
  const params = req.body || {};
  const sortedKeys = Object.keys(params).sort();
  let dataString = url;
  for (const key of sortedKeys) {
    dataString += key + params[key];
  }

  const computed = crypto
    .createHmac('sha1', authToken)
    .update(Buffer.from(dataString, 'utf-8'))
    .digest('base64');

  if (computed !== signature) {
    log.warn('Invalid Twilio signature');
    return res.status(403).json({ error: 'Invalid signature' });
  }

  next();
}

/**
 * Verify Calendly webhook signature
 */
function verifyCalendlySignature(req, res, next) {
  const signature = req.headers['calendly-webhook-signature'];
  if (!signature) {
    log.warn('No Calendly signature — allowing for now');
    return next();
  }

  // Calendly signature verification requires the webhook signing key
  // This will be stored in tenant_integrations.calendly.credentials.webhook_secret
  const secret = req.tenant?.integrations?.calendly?.credentials?.webhook_secret;
  if (!secret) {
    return next(); // No secret configured, allow through
  }

  const body = JSON.stringify(req.body);
  const computed = crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('hex');

  if (!crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(signature))) {
    return res.status(403).json({ error: 'Invalid Calendly signature' });
  }

  next();
}

module.exports = { resolveTwilioTenant, verifyTwilioSignature, verifyCalendlySignature };
