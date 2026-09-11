'use strict';

/**
 * Resend lifecycle reconciliation for provider-accepted FGA outreach.
 *
 * Signed webhooks remain the primary evidence path. This is the independent
 * read-side repair: the Revenue Guardian asks Resend about accepted messages
 * that still lack a terminal local receipt. A missed webhook must not leave a
 * provider-suppressed address active in the seven-touch sequence.
 *
 * Safety:
 *   - exact FGA tenant on every read and write;
 *   - never sends email;
 *   - deterministic provider event IDs make every repair idempotent;
 *   - no recipient, provider ID, subject or body is returned or logged;
 *   - only bounced, complained and provider-suppressed states create a
 *     permanent suppression and stop follow-up work.
 */

const { Resend } = require('resend');
const { FGA_TENANT_ID } = require('../config');
const drip = require('../drip-campaign');
const { recordGrowthEvent } = require('../growth/events');

const DEFAULT_GRACE_MS = 5 * 60 * 1000;
const TERMINAL_LOCAL_EVENTS = new Set([
  'delivered', 'opened', 'clicked', 'bounced', 'complained', 'failed', 'suppressed',
]);
const SUPPRESSION_STATES = new Set(['bounced', 'complained', 'suppressed']);

function normalizeProviderState(value) {
  const state = String(value || '').trim().toLowerCase();
  const aliases = {
    delivery_delayed: 'delayed',
    canceled: 'failed',
  };
  const event = aliases[state] || state;
  if (['delivered', 'opened', 'clicked'].includes(event)) {
    return { event, terminal: true, delivered: true, suppress: false };
  }
  if (SUPPRESSION_STATES.has(event)) {
    return { event, terminal: true, delivered: false, suppress: true };
  }
  if (event === 'failed') {
    return { event, terminal: true, delivered: false, suppress: false };
  }
  if (event === 'delayed') {
    return { event, terminal: false, delivered: false, suppress: false };
  }
  return { event: null, terminal: false, delivered: false, suppress: false };
}

function reconciliationEventId(providerEmailId, event) {
  return `resend-api-reconcile:${providerEmailId}:${event}`;
}

function defaultRetrieveEmail() {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('resend_lifecycle_api_key_missing');
  const resend = new Resend(key);
  return async (providerEmailId) => {
    const receipt = await resend.emails.get(providerEmailId);
    if (receipt.error) throw new Error(`resend_email_read_failed:${receipt.error.message}`);
    if (!receipt.data) throw new Error('resend_email_read_empty');
    // Deliberately return only fields required by reconciliation. The provider
    // response also contains the full subject/body and must never reach logs or
    // result payloads.
    return {
      last_event: receipt.data.last_event,
      recipient: Array.isArray(receipt.data.to) ? receipt.data.to[0] : null,
      // The retrieve endpoint exposes the email creation time, not the time of
      // its latest lifecycle transition. Do not relabel creation as delivery;
      // the reconciliation observation time is the honest fallback below.
      occurred_at: null,
    };
  };
}

async function persistLifecycleEvent(db, { start, state, provider, now }) {
  const expectedRecipient = String(start.recipient || '').trim().toLowerCase() || null;
  const providerRecipient = String(provider.recipient || '').trim().toLowerCase() || null;
  if (expectedRecipient && providerRecipient && expectedRecipient !== providerRecipient) {
    throw new Error('resend_lifecycle_recipient_mismatch');
  }
  const recipient = expectedRecipient || providerRecipient;
  const providerEventId = reconciliationEventId(start.provider_id, state.event);
  const { error } = await db.from('email_events').upsert({
    tenant_id: FGA_TENANT_ID,
    provider: 'resend',
    provider_event_id: providerEventId,
    provider_email_id: start.provider_id,
    recipient,
    event: state.event,
    payload: {
      type: `email.${state.event === 'delayed' ? 'delivery_delayed' : state.event}`,
      source: 'resend_api_reconciliation',
      provider_state: state.event,
      reconciled_at: now.toISOString(),
    },
  }, {
    onConflict: 'provider,provider_event_id',
    ignoreDuplicates: true,
  });
  if (error) throw new Error(`resend_lifecycle_event_write_failed:${error.message}`);

  await recordGrowthEvent(db, {
    tenantId: FGA_TENANT_ID,
    leadId: start.lead_id,
    eventType: `email_${state.event}`,
    stage: state.delivered ? 'delivered' : null,
    sourceSystem: 'resend_api_reconciliation',
    sourceId: providerEventId,
    actor: 'revenue-guardian',
    occurredAt: provider.occurred_at || now.toISOString(),
    evidence: {
      provider_status: state.event,
      retrieval: 'provider_api',
      signed_webhook: false,
    },
    correlationId: start.provider_id,
  });

  if (!state.suppress) return { suppressed: false };
  if (!recipient) throw new Error('resend_lifecycle_suppression_recipient_missing');

  const reason = state.event === 'bounced'
    ? 'bounce'
    : state.event === 'complained' ? 'complaint' : 'provider_suppression';
  await drip.suppress(db, {
    email: recipient,
    reason,
    source: 'resend_api_reconciliation',
    leadId: start.lead_id,
  });

  const automationStatus = state.event === 'bounced' ? 'bounced' : 'blocked_suppressed';
  const leadUpdate = await db.from('leads').update({
    automation_status: automationStatus,
    updated_at: now.toISOString(),
  }).eq('tenant_id', FGA_TENANT_ID).eq('id', start.lead_id);
  if (leadUpdate.error) throw new Error(`resend_lifecycle_lead_stop_failed:${leadUpdate.error.message}`);

  const enrollments = await db.from('drip_enrollments').select('id')
    .eq('tenant_id', FGA_TENANT_ID).eq('lead_id', start.lead_id)
    .in('status', ['active', 'paused', 'review']).limit(20);
  if (enrollments.error) {
    throw new Error(`resend_lifecycle_enrollment_read_failed:${enrollments.error.message}`);
  }
  for (const enrollment of enrollments.data || []) {
    await drip.stopEnrollment(db, enrollment.id, {
      status: 'stopped',
      reason,
      by: 'revenue-guardian',
    });
  }

  if (state.event === 'complained') {
    const complaint = await db.from('attention_queue').upsert({
      tenant_id: FGA_TENANT_ID,
      type: 'email_complaint',
      severity: 'red',
      title: 'Spam complaint from an outreach recipient',
      summary: 'Resend confirmed a complaint during lifecycle reconciliation. The recipient is permanently suppressed and every active follow-up is stopped.',
      payload: { provider_email_id_present: true, source: 'resend_api_reconciliation' },
      produced_by: 'revenue-guardian',
    }, { onConflict: 'tenant_id,type', ignoreDuplicates: true });
    if (complaint.error && !/constraint|unique/i.test(complaint.error.message || '')) {
      throw new Error(`resend_lifecycle_complaint_alert_failed:${complaint.error.message}`);
    }
  }
  return { suppressed: true };
}

async function reconcileResendLifecycle(db, {
  starts = [],
  now = new Date(),
  graceMs = DEFAULT_GRACE_MS,
  retrieveEmail = null,
} = {}) {
  const unique = new Map();
  for (const row of starts || []) {
    if (!row?.provider_id || !row?.lead_id) continue;
    const sentAt = Date.parse(row.sent_at || '');
    if (Number.isFinite(sentAt) && now.getTime() - sentAt < graceMs) continue;
    if (!unique.has(row.provider_id)) unique.set(row.provider_id, row);
  }
  const candidates = [...unique.values()];
  const summary = {
    eligible: candidates.length,
    checked: 0,
    repaired: 0,
    delivered_proof: 0,
    suppressed: 0,
    delayed: 0,
    pending: 0,
    errors: 0,
    sends_messages: false,
  };
  if (!candidates.length) return summary;

  const existing = await db.from('email_events').select('provider_email_id,event')
    .eq('tenant_id', FGA_TENANT_ID)
    .in('provider_email_id', candidates.map((row) => row.provider_id))
    .limit(2000);
  if (existing.error) throw new Error(`resend_lifecycle_existing_read_failed:${existing.error.message}`);
  const terminalIds = new Set((existing.data || [])
    .filter((row) => TERMINAL_LOCAL_EVENTS.has(row.event))
    .map((row) => row.provider_email_id));
  const existingEventKeys = new Set((existing.data || [])
    .map((row) => `${row.provider_email_id}:${row.event}`));
  const unresolved = candidates.filter((row) => !terminalIds.has(row.provider_id));
  if (!unresolved.length) return summary;

  let retrieve = retrieveEmail;
  try {
    retrieve = retrieve || defaultRetrieveEmail();
  } catch (_) {
    summary.errors = unresolved.length;
    return summary;
  }

  for (const start of unresolved) {
    summary.checked++;
    try {
      const provider = await retrieve(start.provider_id);
      const state = normalizeProviderState(provider?.last_event);
      if (!state.event) {
        summary.pending++;
        continue;
      }
      // A delayed email stays unresolved and is checked again at the next
      // guardian checkpoint, but an unchanged delayed state is not repeatedly
      // claimed as a newly repaired receipt.
      if (existingEventKeys.has(`${start.provider_id}:${state.event}`)) {
        if (state.event === 'delayed') summary.delayed++;
        else summary.pending++;
        continue;
      }
      const result = await persistLifecycleEvent(db, { start, state, provider, now });
      existingEventKeys.add(`${start.provider_id}:${state.event}`);
      summary.repaired++;
      if (state.delivered) summary.delivered_proof++;
      if (state.event === 'delayed') summary.delayed++;
      if (result.suppressed) summary.suppressed++;
    } catch (_) {
      // The summary is deliberately PII-free. Revenue reporting turns a
      // nonzero error count into an explicit evidence anomaly.
      summary.errors++;
    }
  }
  return summary;
}

module.exports = {
  DEFAULT_GRACE_MS,
  TERMINAL_LOCAL_EVENTS,
  SUPPRESSION_STATES,
  normalizeProviderState,
  reconciliationEventId,
  reconcileResendLifecycle,
};
