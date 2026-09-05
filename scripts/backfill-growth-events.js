#!/usr/bin/env node
'use strict';

/**
 * Reconstruct the FGA-only growth evidence ledger from durable existing
 * records. Default mode is read-only and emits aggregate counts only.
 * --apply writes idempotent growth_events; it never changes leads, enrolls a
 * prospect, calls a provider, or touches a customer tenant.
 */
require('dotenv').config();

const { getServiceClient, fetchAllRows } = require('../db/client');
const { FGA_TENANT_ID } = require('../core/config');
const { isProspectSource } = require('../core/lead-sources');
const { normalizeEmail } = require('../core/growth/suppression');
const { evaluateEmployeeFit, ICP_VERSION } = require('../core/growth/eligibility');
const { growthEventRow } = require('../core/growth/events');

const APPLY = process.argv.includes('--apply');
const confirmation = process.argv.find((arg) => arg.startsWith('--confirm-tenant='))?.split('=')[1];

function rowsFor(db, table, columns) {
  return fetchAllRows((from, to) => db.from(table).select(columns)
    .eq('tenant_id', FGA_TENANT_ID).order('id', { ascending: true }).range(from, to));
}

function event(input) {
  return growthEventRow({ tenantId: FGA_TENANT_ID, actor: 'growth-ledger-backfill', ...input });
}

async function main() {
  if (APPLY && confirmation !== FGA_TENANT_ID) {
    throw new Error('Exact FGA tenant confirmation is required');
  }
  const db = getServiceClient();
  const [leadsRes, contactsRes, sequencesRes, dripRes, emailRes, inboundRes] = await Promise.all([
    rowsFor(db, 'leads', 'id, lead_source, created_at, updated_at, employee_count_actual, size, lead_score, outreach_ready, status, lifecycle_stage, email, metadata'),
    rowsFor(db, 'contacts', 'id, lead_id, email'),
    rowsFor(db, 'outreach_sequences', 'id, lead_id, sequence_status, created_at, updated_at, metadata'),
    rowsFor(db, 'drip_sends', 'id, lead_id, day_offset, status, resend_id, sent_at, created_at'),
    rowsFor(db, 'email_events', 'id, provider_email_id, recipient, event, created_at'),
    rowsFor(db, 'drip_inbound', 'id, lead_id, gmail_message_id, classification, received_at, created_at'),
  ]);
  for (const result of [leadsRes, contactsRes, sequencesRes, dripRes, emailRes, inboundRes]) {
    if (result.error) throw result.error;
    if (result.truncated) throw new Error('Backfill source inventory exceeded the safety cap');
  }

  const leads = new Map(leadsRes.data.map((lead) => [lead.id, lead]));
  const uniqueLeadByEmail = new Map();
  const ambiguousEmails = new Set();
  const addEmail = (email, leadId) => {
    const normalized = normalizeEmail(email);
    if (!normalized || !leads.has(leadId)) return;
    if (uniqueLeadByEmail.has(normalized) && uniqueLeadByEmail.get(normalized) !== leadId) {
      uniqueLeadByEmail.delete(normalized);
      ambiguousEmails.add(normalized);
    } else if (!ambiguousEmails.has(normalized)) {
      uniqueLeadByEmail.set(normalized, leadId);
    }
  };
  for (const lead of leads.values()) addEmail(lead.email, lead.id);
  for (const contact of contactsRes.data) addEmail(contact.email, contact.lead_id);
  const leadIdsWithUniqueEmail = new Set(uniqueLeadByEmail.values());

  const events = [];
  for (const lead of leads.values()) {
    if (!isProspectSource(lead.lead_source)) continue;
    events.push(event({
      leadId: lead.id, eventType: 'prospect_discovered', stage: 'discovered',
      sourceSystem: 'existing_lead', sourceId: lead.id, occurredAt: lead.created_at,
      evidence: { historical_projection: true }, icpVersion: ICP_VERSION,
    }));
    const hasContact = leadIdsWithUniqueEmail.has(lead.id);
    if (hasContact) {
      events.push(event({
        leadId: lead.id, eventType: 'contact_verified', stage: 'contact_verified',
        sourceSystem: 'existing_contact', sourceId: lead.id, occurredAt: lead.updated_at || lead.created_at,
        evidence: { historical_projection: true, contact_channel: 'email' },
      }));
    }
    const fit = evaluateEmployeeFit(lead);
    if (fit.eligible && lead.outreach_ready === true && Number(lead.lead_score) >= 60) {
      events.push(event({
        leadId: lead.id, eventType: 'prospect_qualified', stage: 'qualified',
        sourceSystem: 'existing_score', sourceId: lead.id, occurredAt: lead.updated_at || lead.created_at,
        evidence: { historical_projection: true, score: Number(lead.lead_score), employee_max: fit.evidence.max },
        icpVersion: ICP_VERSION,
      }));
    }
    if (lead.status === 'won' || lead.lifecycle_stage === 'customer') {
      events.push(event({
        leadId: lead.id, eventType: 'current_won_state', stage: 'won',
        sourceSystem: 'existing_lead_state', sourceId: lead.id, occurredAt: lead.updated_at || lead.created_at,
        evidence: { historical_projection: true, state_verified: true },
      }));
    }
  }

  const leadByProviderEmailId = new Map();
  for (const sequence of sequencesRes.data) {
    if (!leads.has(sequence.lead_id)) continue;
    events.push(event({
      leadId: sequence.lead_id, eventType: 'first_touch_drafted', stage: 'drafted',
      sourceSystem: 'existing_sequence', sourceId: sequence.id, occurredAt: sequence.created_at,
      evidence: { historical_projection: true, sequence_status: sequence.sequence_status },
      messageVersion: sequence.metadata?.message_version || null,
      correlationId: sequence.id,
    }));
    const providerId = sequence.metadata?.delivered?.provider_id || null;
    if (sequence.sequence_status === 'sent' && providerId) {
      leadByProviderEmailId.set(providerId, sequence.lead_id);
      events.push(event({
        leadId: sequence.lead_id, eventType: 'first_touch_provider_accepted', stage: 'provider_accepted',
        sourceSystem: 'resend', sourceId: providerId,
        occurredAt: sequence.metadata?.delivered?.at || sequence.metadata?.sent_at || sequence.updated_at || sequence.created_at,
        evidence: { historical_projection: true, provider_status: 'sent', touch_number: 1 },
        messageVersion: sequence.metadata?.message_version || null,
        correlationId: sequence.id,
      }));
    }
  }

  for (const send of dripRes.data) {
    if (send.status !== 'sent' || !send.resend_id || !leads.has(send.lead_id)) continue;
    leadByProviderEmailId.set(send.resend_id, send.lead_id);
    events.push(event({
      leadId: send.lead_id, eventType: 'sequence_touch_provider_accepted', stage: 'provider_accepted',
      sourceSystem: 'resend', sourceId: send.resend_id, occurredAt: send.sent_at || send.created_at,
      evidence: { historical_projection: true, provider_status: 'sent', touch_day: send.day_offset },
      correlationId: send.id,
    }));
  }

  for (const providerEvent of emailRes.data) {
    if (providerEvent.event !== 'delivered') continue;
    const normalized = normalizeEmail(providerEvent.recipient);
    const leadId = leadByProviderEmailId.get(providerEvent.provider_email_id)
      || (normalized ? uniqueLeadByEmail.get(normalized) : null);
    if (!leadId) continue;
    events.push(event({
      leadId, eventType: 'email_delivered', stage: 'delivered',
      sourceSystem: 'resend', sourceId: providerEvent.id,
      occurredAt: providerEvent.created_at,
      evidence: {
        historical_projection: true,
        provider_status: 'delivered',
        correlation: leadByProviderEmailId.has(providerEvent.provider_email_id)
          ? 'provider_id' : 'unique_recipient',
      },
      correlationId: providerEvent.provider_email_id || null,
    }));
  }

  for (const inbound of inboundRes.data) {
    if (inbound.classification !== 'genuine_reply' || !leads.has(inbound.lead_id)) continue;
    // Historical rows predate the durable intent column, so backfill only the
    // fact of a human reply. New reply events carry warm intent in real time.
    const warm = false;
    events.push(event({
      leadId: inbound.lead_id, eventType: 'human_reply_received',
      stage: warm ? 'warm' : 'human_reply', sourceSystem: 'gmail',
      sourceId: inbound.gmail_message_id || inbound.id,
      occurredAt: inbound.received_at || inbound.created_at,
      evidence: { historical_projection: true, classification: 'genuine_reply', intent: 'historical_unknown' },
    }));
  }

  const deduped = [...new Map(events.map((row) => [row.idempotency_key, row])).values()];
  const byStage = {};
  for (const row of deduped) byStage[row.stage || 'none'] = (byStage[row.stage || 'none'] || 0) + 1;
  console.log(JSON.stringify({
    tenant_scope: 'FGA_ONLY', source_rows: {
      leads: leadsRes.data.length, sequences: sequencesRes.data.length,
      drip_sends: dripRes.data.length, provider_events: emailRes.data.length,
      inbound: inboundRes.data.length,
    },
    candidate_events: deduped.length,
    by_stage: byStage,
    ambiguous_email_matches_excluded: ambiguousEmails.size,
    writes_requested: APPLY,
    changes_leads: false,
    sends_messages: false,
  }, null, 2));
  if (!APPLY) return;

  for (let i = 0; i < deduped.length; i += 250) {
    const { error } = await db.from('growth_events').upsert(deduped.slice(i, i + 250), {
      onConflict: 'tenant_id,idempotency_key',
      ignoreDuplicates: true,
    });
    if (error) throw error;
  }
  console.log(JSON.stringify({ backfill_applied: true, event_count: deduped.length, sends_messages: false }));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
