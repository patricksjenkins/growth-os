'use strict';

/**
 * Aggregate Resend lifecycle evidence for a bounded set of provider-accepted
 * FGA messages.
 *
 * Acceptance is not delivery. This projection keeps those facts separate and
 * returns counts only: provider IDs, recipients, subjects and bodies never
 * leave the server through this contract.
 */

const { FGA_TENANT_ID } = require('../config');

const STATUS_PRIORITY = Object.freeze({
  sent: 10,
  delayed: 20,
  delivered: 30,
  failed: 40,
  suppressed: 50,
  bounced: 60,
  complained: 70,
});

const DELIVERED_EVENTS = new Set(['delivered', 'opened', 'clicked']);
const RECOGNIZED_EVENTS = new Set([
  'sent', 'delayed', 'delivery_delayed',
  'delivered', 'opened', 'clicked',
  'failed', 'suppressed', 'bounced', 'complained',
]);

function normalizedStatus(event) {
  const value = String(event || '').trim().toLowerCase().replace(/^email[.]/, '');
  if (!RECOGNIZED_EVENTS.has(value)) return null;
  if (value === 'delivery_delayed') return 'delayed';
  if (DELIVERED_EVENTS.has(value)) return 'delivered';
  return value;
}

function unavailableLifecycle(accepted, reason = 'provider_lifecycle_read_failed') {
  return {
    available: false,
    accepted,
    observed: null,
    terminal: null,
    delivered: null,
    delayed: null,
    sent: null,
    suppressed: null,
    bounced: null,
    complained: null,
    failed: null,
    unknown: null,
    pending: null,
    evidence_complete: false,
    reason,
  };
}

function summarizeDeliveryLifecycle(providerIds = [], events = []) {
  const acceptedIds = [...new Set((providerIds || []).filter(Boolean).map(String))];
  const acceptedSet = new Set(acceptedIds);
  const statusById = new Map();

  for (const row of events || []) {
    const providerId = row?.provider_email_id ? String(row.provider_email_id) : null;
    if (!providerId || !acceptedSet.has(providerId)) continue;
    const status = normalizedStatus(row.event);
    if (!status) continue;
    const previous = statusById.get(providerId);
    if (!previous || STATUS_PRIORITY[status] > STATUS_PRIORITY[previous]) {
      statusById.set(providerId, status);
    }
  }

  const counts = {
    delivered: 0,
    delayed: 0,
    sent: 0,
    suppressed: 0,
    bounced: 0,
    complained: 0,
    failed: 0,
  };
  for (const status of statusById.values()) counts[status] += 1;

  const accepted = acceptedIds.length;
  const observed = statusById.size;
  const unknown = accepted - observed;
  const terminal = counts.delivered + counts.suppressed + counts.bounced
    + counts.complained + counts.failed;
  const pending = counts.delayed + counts.sent + unknown;

  return {
    available: true,
    accepted,
    observed,
    terminal,
    ...counts,
    unknown,
    pending,
    // Complete means every accepted provider ID has at least one recognized
    // lifecycle receipt. Delayed/sent remain explicitly pending even when the
    // evidence set itself is complete.
    evidence_complete: unknown === 0,
    reason: null,
  };
}

async function readDeliveryLifecycle(db, {
  starts = [],
  tenantId = FGA_TENANT_ID,
} = {}) {
  // This reader is deliberately exact-FGA. It is an internal company outcome
  // contract, never a tenant-selectable reporting surface.
  if (tenantId !== FGA_TENANT_ID) return unavailableLifecycle(0, 'non_fga_tenant_rejected');
  const providerIds = [...new Set((starts || [])
    .map((row) => row?.provider_id)
    .filter(Boolean)
    .map(String))];
  if (!providerIds.length) return summarizeDeliveryLifecycle([], []);

  const receipt = await db.from('email_events')
    .select('provider_email_id,event')
    .eq('tenant_id', FGA_TENANT_ID)
    .eq('provider', 'resend')
    .in('provider_email_id', providerIds)
    .limit(5000);
  if (receipt.error) return unavailableLifecycle(providerIds.length);
  return summarizeDeliveryLifecycle(providerIds, receipt.data || []);
}

module.exports = {
  STATUS_PRIORITY,
  normalizedStatus,
  unavailableLifecycle,
  summarizeDeliveryLifecycle,
  readDeliveryLifecycle,
};
