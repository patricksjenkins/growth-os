'use strict';

/**
 * Exact-FGA restart manifest planning and rotation.
 *
 * Planning is read-only. Persistence makes a complete candidate set visible
 * only after every row has been written. Rotation is protected by the
 * tenant-scoped idempotency ledger and is allowed only after the current
 * completed manifest has no eligible candidate or unconsumed authorization.
 * Nothing in this module creates a draft or calls a messaging provider.
 */

const { fetchAllRows } = require('../../db/client');
const { FGA_TENANT_ID } = require('../config');
const { normalizeEmail } = require('./suppression');
const { classifyRestartCandidate, POLICY_VERSION } = require('./restart-policy');
const {
  loadProtectedOrganizationIndex,
  matchProtectedOrganization,
} = require('./customer-boundary');
const sevenTouch = require('./seven-touch-plan');

const ROTATION_ACTION = 'rotate_fga_restart_manifest';
const ROTATION_LEASE_MS = 30 * 60 * 1000;

function rowsFor(db, table, columns) {
  return fetchAllRows((from, to) => db.from(table).select(columns)
    .eq('tenant_id', FGA_TENANT_ID)
    .order('id', { ascending: true })
    .range(from, to));
}

function lastIso(values) {
  return values.filter(Boolean).sort().at(-1) || null;
}

function summarizeDecisions(decisions = []) {
  const byDecision = {};
  const byReason = {};
  for (const row of decisions) {
    byDecision[row.decision] = (byDecision[row.decision] || 0) + 1;
    byReason[row.reason] = (byReason[row.reason] || 0) + 1;
  }
  return {
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
}

async function buildFgaRestartManifest(db, { now = new Date() } = {}) {
  const [
    leadsRes, contactsRes, leadSuppRes, dripSuppRes,
    inboundRes, eventsRes, sequencesRes,
  ] = await Promise.all([
    rowsFor(db, 'leads', 'id, company_name, lead_source, status, lifecycle_stage, employee_count_actual, size, lead_score, outreach_ready, email, metadata, created_at'),
    rowsFor(db, 'contacts', 'id, lead_id, email'),
    rowsFor(db, 'lead_suppressions', 'id, lead_id, email, channel'),
    rowsFor(db, 'drip_suppressions', 'id, email'),
    rowsFor(db, 'drip_inbound', 'id, lead_id, classification'),
    rowsFor(db, 'email_events', 'id, recipient, event, created_at'),
    rowsFor(db, 'outreach_sequences', 'id, lead_id, sequence_status, created_at, metadata'),
  ]);
  for (const result of [leadsRes, contactsRes, leadSuppRes, dripSuppRes, inboundRes, eventsRes, sequencesRes]) {
    if (result.error) throw result.error;
    if (result.truncated) throw new Error('restart_manifest_inventory_truncated');
  }

  const contactsByLead = new Map();
  for (const row of contactsRes.data) {
    const email = normalizeEmail(row.email);
    if (email && !contactsByLead.has(row.lead_id)) contactsByLead.set(row.lead_id, email);
  }
  const protectedOrganizations = await loadProtectedOrganizationIndex(db);
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
        customerMatch: matchProtectedOrganization(protectedOrganizations, {
          email,
          companyName: lead.company_name,
        }).protected,
        suppressed: leadSuppressions.has(lead.id) || Boolean(email && suppressedEmails.has(email)),
        negativeDelivery: Boolean(email && negativeEmails.has(email)),
        humanReply: humanReplyLeads.has(lead.id),
        lastAcceptedAt: lastIso(sentByLead.get(lead.id) || []),
      },
      now,
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

  return { decisions, summary: summarizeDecisions(decisions) };
}

async function markBatchFailed(db, batchId, error) {
  if (!batchId) return;
  await db.from('growth_restart_batches').update({
    status: 'failed',
    applied_summary: { error: String(error?.message || error || 'manifest_write_failed').slice(0, 500) },
  }).eq('tenant_id', FGA_TENANT_ID).eq('id', batchId).eq('status', 'draft');
}

async function persistFgaRestartManifest(db, {
  decisions = [],
  summary,
  status = 'validated',
  createdBy = 'codex',
  supersedesBatchId = null,
} = {}) {
  if (!['validated', 'completed'].includes(status)) {
    throw new Error('restart_manifest_invalid_target_status');
  }
  const now = new Date().toISOString();
  const { data: batch, error: batchError } = await db.from('growth_restart_batches').insert({
    tenant_id: FGA_TENANT_ID,
    status: 'draft',
    policy_version: POLICY_VERSION,
    sequence_plan_key: sevenTouch.PLAN_KEY,
    dry_run_summary: summary || summarizeDecisions(decisions),
    created_by: createdBy,
    validated_at: now,
    ...(supersedesBatchId ? {
      applied_summary: {
        automatic_rotation: status === 'completed',
        supersedes_batch_id: supersedesBatchId,
        authorized: 0,
        sends_messages: false,
      },
    } : {}),
  }).select('id').single();
  if (batchError || !batch?.id) throw batchError || new Error('restart_manifest_batch_insert_failed');

  try {
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
    const { data: published, error: publishError } = await db.from('growth_restart_batches')
      .update({ status })
      .eq('tenant_id', FGA_TENANT_ID)
      .eq('id', batch.id)
      .eq('status', 'draft')
      .select('id,status')
      .maybeSingle();
    if (publishError || !published?.id) {
      throw publishError || new Error('restart_manifest_publish_claim_lost');
    }
    return { batch: published, candidateCount: decisions.length };
  } catch (error) {
    await markBatchFailed(db, batch.id, error);
    throw error;
  }
}

function rotationLeaseKey(exhaustedBatchId) {
  return `growth_restart_rotation:${String(exhaustedBatchId || '')}`;
}

function isUniqueViolation(error) {
  return error?.code === '23505' || /duplicate key|unique constraint/i.test(String(error?.message || ''));
}

async function releaseRotationLease(db, key) {
  const { error } = await db.from('idempotency_keys').delete()
    .eq('tenant_id', FGA_TENANT_ID)
    .eq('key', key)
    .eq('action', ROTATION_ACTION);
  if (error) throw error;
}

async function rotateFgaRestartManifest(db, {
  exhaustedBatchId,
  buildManifest = buildFgaRestartManifest,
  persistManifest = persistFgaRestartManifest,
  leaseRetry = false,
} = {}) {
  if (!exhaustedBatchId) throw new Error('restart_manifest_rotation_missing_batch');

  const [{ data: latest, error: latestError }, remaining, unconsumed] = await Promise.all([
    db.from('growth_restart_batches').select('id')
      .eq('tenant_id', FGA_TENANT_ID)
      .eq('status', 'completed')
      .eq('sequence_plan_key', sevenTouch.PLAN_KEY)
      .order('created_at', { ascending: false }).limit(1).maybeSingle(),
    db.from('growth_restart_candidates').select('id', { count: 'exact', head: true })
      .eq('tenant_id', FGA_TENANT_ID)
      .eq('batch_id', exhaustedBatchId)
      .eq('decision', 'eligible')
      .is('authorized_at', null),
    db.from('growth_restart_candidates').select('id', { count: 'exact', head: true })
      .eq('tenant_id', FGA_TENANT_ID)
      .eq('decision', 'eligible')
      .not('authorized_at', 'is', null)
      .is('first_touch_sent_at', null),
  ]);
  if (latestError || remaining.error || unconsumed.error) {
    throw latestError || remaining.error || unconsumed.error;
  }
  if (String(latest?.id || '') !== String(exhaustedBatchId)) {
    return { rotated: false, reason: 'newer_completed_manifest_exists', batch: latest || null };
  }
  if ((remaining.count || 0) > 0) {
    return { rotated: false, reason: 'manifest_not_exhausted', remaining: remaining.count };
  }
  if ((unconsumed.count || 0) > 0) {
    return { rotated: false, reason: 'prior_authorization_unconsumed', pending: unconsumed.count };
  }

  const key = rotationLeaseKey(exhaustedBatchId);
  const leaseExpiresAt = new Date(Date.now() + ROTATION_LEASE_MS).toISOString();
  const { error: leaseError } = await db.from('idempotency_keys').insert({
    tenant_id: FGA_TENANT_ID,
    key,
    action: ROTATION_ACTION,
    result: { state: 'planning', sends_messages: false },
    expires_at: leaseExpiresAt,
  });
  if (leaseError) {
    if (!isUniqueViolation(leaseError)) throw leaseError;
    const { data: current, error } = await db.from('growth_restart_batches').select('id,status')
      .eq('tenant_id', FGA_TENANT_ID)
      .eq('status', 'completed')
      .eq('sequence_plan_key', sevenTouch.PLAN_KEY)
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (error) throw error;
    if (String(current?.id || '') !== String(exhaustedBatchId)) {
      return { rotated: true, reason: 'rotation_already_claimed', batch: current };
    }
    const { data: lease, error: leaseReadError } = await db.from('idempotency_keys')
      .select('expires_at,result')
      .eq('tenant_id', FGA_TENANT_ID)
      .eq('key', key)
      .eq('action', ROTATION_ACTION)
      .maybeSingle();
    if (leaseReadError) throw leaseReadError;
    const expired = lease?.expires_at && Date.parse(lease.expires_at) <= Date.now();
    if (expired && !leaseRetry) {
      const { data: released, error: releaseError } = await db.from('idempotency_keys').delete()
        .eq('tenant_id', FGA_TENANT_ID)
        .eq('key', key)
        .eq('action', ROTATION_ACTION)
        .lte('expires_at', new Date().toISOString())
        .select('id')
        .maybeSingle();
      if (releaseError) throw releaseError;
      if (released?.id) {
        return rotateFgaRestartManifest(db, {
          exhaustedBatchId,
          buildManifest,
          persistManifest,
          leaseRetry: true,
        });
      }
    }
    return { rotated: false, reason: 'rotation_in_progress', batch: current || null };
  }

  try {
    const manifest = await buildManifest(db);
    const eligible = manifest.summary.by_decision.eligible || 0;
    if (!eligible) {
      await releaseRotationLease(db, key);
      return { rotated: false, reason: 'no_eligible_candidates', summary: manifest.summary };
    }
    const persisted = await persistManifest(db, {
      ...manifest,
      status: 'completed',
      createdBy: 'growth-restart',
      supersedesBatchId: exhaustedBatchId,
    });
    await db.from('idempotency_keys').update({
      result: {
        state: 'completed',
        batch_id: persisted.batch.id,
        eligible,
        sends_messages: false,
      },
      expires_at: null,
    }).eq('tenant_id', FGA_TENANT_ID).eq('key', key).eq('action', ROTATION_ACTION);
    return {
      rotated: true,
      reason: 'replacement_manifest_created',
      batch: persisted.batch,
      summary: manifest.summary,
    };
  } catch (error) {
    await releaseRotationLease(db, key);
    throw error;
  }
}

module.exports = {
  ROTATION_ACTION,
  ROTATION_LEASE_MS,
  buildFgaRestartManifest,
  isUniqueViolation,
  persistFgaRestartManifest,
  rotateFgaRestartManifest,
  rotationLeaseKey,
  summarizeDecisions,
};
