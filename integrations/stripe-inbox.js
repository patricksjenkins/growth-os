'use strict';

/**
 * Durable Stripe webhook inbox.
 *
 * Codex audit 2026-07-26: the webhook route answered HTTP 200 to every handler
 * result — including errors, orphans and locked periods. Stripe treats 200 as
 * delivered and stops retrying, so a soft failure destroyed the event with no
 * record it had ever arrived. Nothing could be replayed because nothing was
 * stored.
 *
 * The order here is the whole point:
 *   1. verify the signature (an unauthenticated payload is never stored)
 *   2. RECORD the event, before any business logic runs
 *   3. process it
 *   4. record the outcome
 *
 * If step 3 explodes, step 2 already happened — the event is on disk and
 * replayable, and the caller is told to make Stripe retry. Nothing is lost by
 * a bug in a handler, which is exactly what went wrong before.
 */

const { createLogger } = require('../core/logger');
const { getServiceClient } = require('../db/client');

const log = createLogger('stripe-inbox');

/** Map a handler result to an inbox status. */
function classify(result) {
  if (!result || typeof result !== 'object') return 'processed';
  if (result.status === 'error' || result.error) return 'rejected';
  if (result.status === 'orphaned') return 'orphaned';
  if (result.status === 'period_locked') return 'rejected';
  if (result.action === 'ignored') return 'ignored';
  return 'processed';
}

/**
 * Statuses Stripe should retry.
 *
 * `rejected` = we failed, so ask Stripe to try again later.
 * `orphaned` = the event is fine, WE are missing a customer link. Retrying
 *   changes nothing (the link is a human action), and an endless retry storm
 *   would bury the real signal — the owner already gets an attention item.
 * `ignored`/`processed` = deliberate outcomes.
 */
const RETRYABLE = new Set(['rejected']);

/**
 * @returns {{eventId, status, retryable, result, error}}
 * @throws only on signature-verification failure (caller answers 400).
 */
async function handleWebhookDurable(payload, signature) {
  const stripeLib = require('stripe')(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  // 1. Authenticate FIRST. An unverified payload is never written anywhere.
  let event;
  try {
    event = stripeLib.webhooks.constructEvent(payload, signature, webhookSecret);
  } catch (err) {
    log.error(`Signature verification failed: ${err.message}`);
    throw new Error(`Webhook signature verification failed: ${err.message}`);
  }

  const db = getServiceClient();

  // 2. Record arrival before doing anything with it. Conflict on the event id
  //    means Stripe redelivered — update, never duplicate.
  const { data: existingRows } = await db.from('stripe_events')
    .select('id, status, attempts').eq('stripe_event_id', event.id).limit(1);
  const existing = existingRows?.[0] || null;

  if (existing && existing.status === 'processed') {
    // Already done. Answer success without re-running side effects — this is
    // the idempotency guarantee Stripe's at-least-once delivery requires.
    log.info(`Event ${event.id} already processed — acknowledging without reprocessing`);
    return { eventId: event.id, status: 'processed', retryable: false, result: { duplicate: true } };
  }

  const base = {
    stripe_event_id: event.id,
    stripe_account_id: event.account || null,
    event_type: event.type,
    livemode: event.livemode === true,
    payload: event,
    status: 'received',
    attempts: (existing?.attempts || 0) + 1,
    updated_at: new Date().toISOString(),
  };
  if (existing) {
    await db.from('stripe_events').update(base).eq('id', existing.id).then(() => {}, () => {});
  } else {
    const { error } = await db.from('stripe_events').insert(base);
    if (error) {
      // Storage failed. Do NOT process — process-without-record is exactly the
      // condition that made the old failure invisible. Make Stripe retry.
      log.error(`Inbox write failed for ${event.id}: ${error.message}`);
      return {
        eventId: event.id, status: 'rejected', retryable: true,
        error: `inbox write failed: ${error.message}`,
      };
    }
  }

  // A live-mode webhook delivering test traffic (or vice versa) means the keys
  // and the endpoint disagree — worth saying out loud rather than silently
  // booking sandbox money.
  if (event.livemode === false) {
    log.warn(`Event ${event.id} is TEST-mode traffic (livemode=false) on this endpoint`);
  }

  // 3. Process.
  let result = null;
  let status = 'processed';
  let errText = null;
  try {
    const { handleWebhook } = require('./stripe');
    result = await handleWebhook(payload, signature);
    status = classify(result);
    if (status === 'rejected') errText = result?.error || `handler returned ${result?.status}`;
  } catch (err) {
    status = 'rejected';
    errText = err.message;
    log.error(`Handler threw for ${event.id}: ${err.message}`);
  }

  // 4. Record the outcome. The event stays on disk either way.
  await db.from('stripe_events').update({
    status,
    result: result || null,
    error: errText,
    processed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('stripe_event_id', event.id).then(() => {}, () => {});

  return {
    eventId: event.id,
    status,
    retryable: RETRYABLE.has(status),
    result,
    error: errText,
  };
}

module.exports = { handleWebhookDurable, classify, RETRYABLE };
