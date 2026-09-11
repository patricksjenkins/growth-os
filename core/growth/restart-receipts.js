'use strict';

/**
 * Reconcile the FGA restart authorization ledger against provider-backed
 * sequence evidence.
 *
 * There are two safe repairs:
 *   1. The exact sequence bound to an authorization was accepted by the
 *      provider, but first_touch_sent_at was not persisted. Copy the immutable
 *      delivered timestamp into the candidate receipt.
 *   2. An older bound draft was superseded and a later, separately authorized
 *      restart for the same lead was accepted. Retire the old authorization as
 *      excluded; never pretend its superseded sequence was sent.
 *
 * Anything else remains unconsumed and continues to block manifest rotation.
 * This module never drafts or sends a message and is exact-FGA only.
 */

const { fetchAllRows } = require('../../db/client');
const { FGA_TENANT_ID } = require('../config');

const SUPERSEDED_REASON = 'superseded_by_provider_accepted_restart';

function deliveredEvidence(sequence) {
  const delivered = sequence?.metadata?.delivered || {};
  const at = delivered.at || sequence?.metadata?.sent_at || null;
  const providerId = delivered.provider_id || null;
  if (sequence?.sequence_status !== 'sent' || !at || !providerId) return null;
  if (!Number.isFinite(Date.parse(at))) return null;
  return { sentAt: at, providerId };
}

function planRestartReceiptReconciliation({ unconsumed = [], consumed = [], sequences = [] } = {}) {
  const sequenceById = new Map((sequences || []).map((row) => [String(row.id), row]));
  const consumedByLead = new Map();
  for (const row of consumed || []) {
    if (!row?.lead_id || !row?.first_touch_sequence_id || !row?.first_touch_sent_at) continue;
    const sequence = sequenceById.get(String(row.first_touch_sequence_id));
    const proof = deliveredEvidence(sequence);
    if (!proof || String(sequence.lead_id) !== String(row.lead_id)) continue;
    const values = consumedByLead.get(String(row.lead_id)) || [];
    values.push({ candidate: row, sequence, proof });
    consumedByLead.set(String(row.lead_id), values);
  }

  const actions = [];
  for (const candidate of unconsumed || []) {
    if (!candidate?.id || !candidate?.lead_id || !candidate?.first_touch_sequence_id) continue;
    const bound = sequenceById.get(String(candidate.first_touch_sequence_id));
    const boundProof = deliveredEvidence(bound);
    if (boundProof && String(bound.lead_id) === String(candidate.lead_id)) {
      actions.push({
        type: 'consume_bound_receipt',
        candidateId: candidate.id,
        batchId: candidate.batch_id,
        leadId: candidate.lead_id,
        sequenceId: candidate.first_touch_sequence_id,
        sentAt: boundProof.sentAt,
      });
      continue;
    }

    // A different send cannot consume this authorization unless the original
    // bound draft is explicitly retired and the later send has its own durable
    // authorization receipt. This prevents an unrelated historical send from
    // making stranded work disappear.
    if (bound?.sequence_status !== 'superseded') continue;
    const authorizedAt = Date.parse(candidate.authorized_at || '');
    if (!Number.isFinite(authorizedAt)) continue;
    const replacement = (consumedByLead.get(String(candidate.lead_id)) || [])
      .filter(({ candidate: later, proof }) => (
        String(later.id) !== String(candidate.id)
        && Date.parse(later.authorized_at || '') >= authorizedAt
        && Date.parse(proof.sentAt) >= authorizedAt
      ))
      .sort((a, b) => Date.parse(a.proof.sentAt) - Date.parse(b.proof.sentAt))[0];
    if (!replacement) continue;
    actions.push({
      type: 'exclude_superseded_authorization',
      candidateId: candidate.id,
      batchId: candidate.batch_id,
      leadId: candidate.lead_id,
      sequenceId: candidate.first_touch_sequence_id,
      replacementCandidateId: replacement.candidate.id,
      replacementSequenceId: replacement.sequence.id,
      observedSentAt: replacement.proof.sentAt,
    });
  }
  return actions;
}

async function allRows(builder, label) {
  const result = await fetchAllRows((from, to) => builder(from, to));
  if (result.error) throw new Error(`${label}:${result.error.message}`);
  if (result.truncated) throw new Error(`${label}:inventory_truncated`);
  return result.data;
}

async function rowsInChunks(values, load) {
  const rows = [];
  const unique = [...new Set((values || []).filter(Boolean))];
  for (let index = 0; index < unique.length; index += 100) {
    rows.push(...await load(unique.slice(index, index + 100)));
  }
  return rows;
}

async function reconcileRestartReceipts(db, { observedAt = new Date().toISOString() } = {}) {
  const unconsumed = await allRows((from, to) => db.from('growth_restart_candidates')
    .select('id,batch_id,lead_id,decision,reason,evidence,authorized_at,first_touch_sequence_id,first_touch_sent_at')
    .eq('tenant_id', FGA_TENANT_ID)
    .eq('decision', 'eligible')
    .not('authorized_at', 'is', null)
    .is('first_touch_sent_at', null)
    .order('id', { ascending: true })
    .range(from, to), 'restart_receipts_unconsumed');
  if (!unconsumed.length) {
    return { examined: 0, consumed_bound: 0, excluded_superseded: 0, unresolved: 0, sends_messages: false };
  }

  const leadIds = unconsumed.map((row) => row.lead_id);
  const consumed = await rowsInChunks(leadIds, (chunk) => allRows((from, to) => db
    .from('growth_restart_candidates')
    .select('id,batch_id,lead_id,authorized_at,first_touch_sequence_id,first_touch_sent_at')
    .eq('tenant_id', FGA_TENANT_ID)
    .eq('decision', 'eligible')
    .in('lead_id', chunk)
    .not('authorized_at', 'is', null)
    .not('first_touch_sent_at', 'is', null)
    .order('id', { ascending: true })
    .range(from, to), 'restart_receipts_consumed'));
  const sequenceIds = [
    ...unconsumed.map((row) => row.first_touch_sequence_id),
    ...consumed.map((row) => row.first_touch_sequence_id),
  ];
  const sequences = await rowsInChunks(sequenceIds, (chunk) => allRows((from, to) => db
    .from('outreach_sequences')
    .select('id,lead_id,sequence_status,metadata')
    .eq('tenant_id', FGA_TENANT_ID)
    .in('id', chunk)
    .order('id', { ascending: true })
    .range(from, to), 'restart_receipt_sequences'));

  const actions = planRestartReceiptReconciliation({ unconsumed, consumed, sequences });
  let consumedBound = 0;
  let excludedSuperseded = 0;
  for (const action of actions) {
    if (action.type === 'consume_bound_receipt') {
      const { data, error } = await db.from('growth_restart_candidates')
        .update({ first_touch_sent_at: action.sentAt })
        .eq('tenant_id', FGA_TENANT_ID)
        .eq('id', action.candidateId)
        .eq('batch_id', action.batchId)
        .eq('lead_id', action.leadId)
        .eq('decision', 'eligible')
        .eq('first_touch_sequence_id', action.sequenceId)
        .is('first_touch_sent_at', null)
        .select('id').maybeSingle();
      if (error) throw new Error(`restart_receipt_consume:${error.message}`);
      if (data?.id) consumedBound += 1;
      continue;
    }

    const original = unconsumed.find((row) => String(row.id) === String(action.candidateId));
    const { data, error } = await db.from('growth_restart_candidates')
      .update({
        decision: 'excluded',
        reason: SUPERSEDED_REASON,
        evidence: {
          ...(original?.evidence || {}),
          receipt_reconciliation: {
            state: SUPERSEDED_REASON,
            replacement_candidate_id: action.replacementCandidateId,
            replacement_sequence_id: action.replacementSequenceId,
            provider_accepted_at: action.observedSentAt,
            observed_at: observedAt,
          },
        },
      })
      .eq('tenant_id', FGA_TENANT_ID)
      .eq('id', action.candidateId)
      .eq('batch_id', action.batchId)
      .eq('lead_id', action.leadId)
      .eq('decision', 'eligible')
      .eq('first_touch_sequence_id', action.sequenceId)
      .is('first_touch_sent_at', null)
      .select('id').maybeSingle();
    if (error) throw new Error(`restart_receipt_supersede:${error.message}`);
    if (data?.id) excludedSuperseded += 1;
  }

  return {
    examined: unconsumed.length,
    consumed_bound: consumedBound,
    excluded_superseded: excludedSuperseded,
    unresolved: Math.max(0, unconsumed.length - consumedBound - excludedSuperseded),
    sends_messages: false,
  };
}

module.exports = {
  SUPERSEDED_REASON,
  deliveredEvidence,
  planRestartReceiptReconciliation,
  reconcileRestartReceipts,
};
