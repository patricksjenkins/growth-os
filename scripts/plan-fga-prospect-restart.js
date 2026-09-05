#!/usr/bin/env node
'use strict';

/**
 * Produce a privacy-safe, FGA-only restart manifest. Default mode is read-only
 * and prints aggregate counts. --write-manifest persists decisions after
 * migration 106, but does not change leads, enrollments, campaigns, jobs, or
 * send any message.
 */
require('dotenv').config();

const { getServiceClient, fetchAllRows } = require('../db/client');
const { FGA_TENANT_ID } = require('../core/config');
const { normalizeEmail } = require('../core/growth/suppression');
const { classifyRestartCandidate, POLICY_VERSION } = require('../core/growth/restart-policy');
const sevenTouch = require('../core/growth/seven-touch-plan');

const WRITE_MANIFEST = process.argv.includes('--write-manifest');
const confirmation = process.argv.find((arg) => arg.startsWith('--confirm-tenant='))?.split('=')[1];

function rowsFor(db, table, columns) {
  return fetchAllRows((from, to) => db.from(table).select(columns)
    .eq('tenant_id', FGA_TENANT_ID).order('id', { ascending: true }).range(from, to));
}

function lastIso(values) {
  return values.filter(Boolean).sort().at(-1) || null;
}

async function main() {
  if (WRITE_MANIFEST && confirmation !== FGA_TENANT_ID) {
    throw new Error('Exact FGA tenant confirmation is required to write the manifest');
  }
  const db = getServiceClient();
  const [
    leadsRes, contactsRes, customersRes, leadSuppRes, dripSuppRes,
    inboundRes, eventsRes, sequencesRes,
  ] = await Promise.all([
    rowsFor(db, 'leads', 'id, lead_source, status, lifecycle_stage, employee_count_actual, size, lead_score, outreach_ready, email, metadata'),
    rowsFor(db, 'contacts', 'id, lead_id, email'),
    rowsFor(db, 'customers', 'id, email'),
    rowsFor(db, 'lead_suppressions', 'id, lead_id, email, channel'),
    rowsFor(db, 'drip_suppressions', 'id, email'),
    rowsFor(db, 'drip_inbound', 'id, lead_id, classification'),
    rowsFor(db, 'email_events', 'id, recipient, event, created_at'),
    rowsFor(db, 'outreach_sequences', 'id, lead_id, sequence_status, created_at, metadata'),
  ]);
  for (const result of [leadsRes, contactsRes, customersRes, leadSuppRes, dripSuppRes, inboundRes, eventsRes, sequencesRes]) {
    if (result.error) throw result.error;
    if (result.truncated) throw new Error('Restart inventory hit a safety cap; no manifest produced');
  }

  const contactsByLead = new Map();
  for (const row of contactsRes.data) {
    const email = normalizeEmail(row.email);
    if (email && !contactsByLead.has(row.lead_id)) contactsByLead.set(row.lead_id, email);
  }
  const customerEmails = new Set(customersRes.data.map((row) => normalizeEmail(row.email)).filter(Boolean));
  const leadSuppressions = new Set(leadSuppRes.data.map((row) => row.lead_id).filter(Boolean));
  const suppressedEmails = new Set([
    ...leadSuppRes.data.map((row) => normalizeEmail(row.email)),
    ...dripSuppRes.data.map((row) => normalizeEmail(row.email)),
  ].filter(Boolean));
  const humanReplyLeads = new Set(inboundRes.data
    .filter((row) => ['genuine_reply', 'ambiguous', 'unsubscribe'].includes(row.classification))
    .map((row) => row.lead_id));
  const negativeEmails = new Set(eventsRes.data
    .filter((row) => ['bounced', 'complained', 'suppressed', 'failed'].includes(row.event))
    .map((row) => normalizeEmail(row.recipient)).filter(Boolean));
  const sentByLead = new Map();
  for (const row of sequencesRes.data) {
    if (row.sequence_status !== 'sent') continue;
    const at = row.metadata?.delivered?.at || row.metadata?.sent_at || row.created_at;
    const values = sentByLead.get(row.lead_id) || [];
    values.push(at);
    sentByLead.set(row.lead_id, values);
  }

  const decisions = leadsRes.data.map((lead) => {
    const email = normalizeEmail(lead.email) || contactsByLead.get(lead.id) || null;
    const result = classifyRestartCandidate({
      tenantId: FGA_TENANT_ID,
      lead,
      context: {
        hasEmail: Boolean(email),
        customerMatch: Boolean(email && customerEmails.has(email)),
        suppressed: leadSuppressions.has(lead.id) || Boolean(email && suppressedEmails.has(email)),
        negativeDelivery: Boolean(email && negativeEmails.has(email)),
        humanReply: humanReplyLeads.has(lead.id),
        lastAcceptedAt: lastIso(sentByLead.get(lead.id) || []),
      },
    });
    return {
      lead_id: lead.id,
      ...result,
      evidence: {
        ...(result.evidence || {}),
        original_status: lead.status || null,
        original_lifecycle_stage: lead.lifecycle_stage || null,
      },
    };
  });

  const byDecision = {};
  const byReason = {};
  for (const row of decisions) {
    byDecision[row.decision] = (byDecision[row.decision] || 0) + 1;
    byReason[row.reason] = (byReason[row.reason] || 0) + 1;
  }
  const summary = {
    tenant_scope: 'FGA_ONLY',
    policy_version: POLICY_VERSION,
    sequence_plan_key: sevenTouch.PLAN_KEY,
    leads_examined: decisions.length,
    by_decision: byDecision,
    by_reason: byReason,
    contains_contact_data: false,
    changes_leads: false,
    enrolls_prospects: false,
    sends_messages: false,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!WRITE_MANIFEST) return;

  const { data: batch, error: batchError } = await db.from('growth_restart_batches').insert({
    tenant_id: FGA_TENANT_ID,
    status: 'validated',
    policy_version: POLICY_VERSION,
    sequence_plan_key: sevenTouch.PLAN_KEY,
    dry_run_summary: summary,
    validated_at: new Date().toISOString(),
  }).select('id').single();
  if (batchError) throw batchError;

  for (let i = 0; i < decisions.length; i += 250) {
    const rows = decisions.slice(i, i + 250).map((row) => ({
      batch_id: batch.id,
      tenant_id: FGA_TENANT_ID,
      lead_id: row.lead_id,
      decision: row.decision,
      reason: row.reason,
      evidence: row.evidence,
    }));
    const { error } = await db.from('growth_restart_candidates').insert(rows);
    if (error) throw error;
  }
  console.log(JSON.stringify({ manifest_written: true, batch_id: batch.id, candidate_count: decisions.length }));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
