/**
 * Growth OS — Stripe Webhook Route
 * POST /webhooks/stripe
 *
 * Must use raw body parsing for Stripe signature verification.
 * Mount BEFORE express.json() middleware or with express.raw().
 */

const express = require('express');
const router = express.Router();
const { handleWebhook } = require('../../integrations/stripe');
const { createLogger } = require('../../core/logger');
const log = createLogger('stripe-webhook');

/**
 * POST /webhooks/stripe
 * Receives Stripe webhook events.
 * IMPORTANT: This route needs raw body — mount with express.raw({ type: 'application/json' })
 */
router.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['stripe-signature'];

  if (!signature) {
    log.warn('Webhook received without Stripe-Signature header');
    return res.status(400).json({ error: 'Missing Stripe-Signature header' });
  }

  try {
    const result = await handleWebhook(req.body, signature);
    log.info(`Webhook processed: ${result.action}`);
    res.json({ received: true, result });
  } catch (err) {
    log.error(`Webhook processing failed: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
