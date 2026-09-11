'use strict';

/**
 * Durable, exact-FGA handoffs between the Growth Engine research stages.
 *
 * Customer tenants deliberately return unchanged: their deployed scheduling
 * and outreach behavior is outside the FGA restart program. These helpers
 * create internal jobs only. They never call an email provider.
 */

const { FGA_TENANT_ID } = require('../config');
const { countActionableDrafts } = require('../revenue/actionable-drafts');
const { readDailyTarget } = require('../revenue/daily-outcome');

function uniqueIds(values = []) {
  return [...new Set(values.filter(Boolean).map(String))];
}

function draftInventoryDays(value = process.env.FGA_DRAFT_INVENTORY_DAYS) {
  const parsed = Number(value || 2);
  if (!Number.isFinite(parsed)) return 2;
  return Math.max(1, Math.min(7, Math.floor(parsed)));
}

function queuedDraftCapacity(jobs = []) {
  return jobs.reduce((total, row) => {
    const payload = row?.payload || {};
    if (payload.mode === 'fb_fallback') return total;
    const requested = payload.lead_id ? 1 : Number(payload.limit || 1);
    return total + (Number.isFinite(requested) ? Math.max(1, Math.min(200, Math.floor(requested))) : 1);
  }, 0);
}

function draftInventoryTarget(dailyTarget, days = process.env.FGA_DRAFT_INVENTORY_DAYS) {
  const parsedTarget = Number(dailyTarget || 25);
  const safeTarget = Number.isFinite(parsedTarget) && parsedTarget > 0 ? parsedTarget : 25;
  return Math.max(1, Math.ceil(safeTarget * draftInventoryDays(days)));
}

async function enqueueFgaScoringHandoffs(client, tenantId, leadIds, {
  source = 'growth_research_handoff',
  priority = 7,
} = {}) {
  if (tenantId !== FGA_TENANT_ID) {
    return { queued: 0, skipped: uniqueIds(leadIds).length, reason: 'customer_tenant_unchanged' };
  }
  const ids = uniqueIds(leadIds);
  if (!ids.length) return { queued: 0, skipped: 0 };

  const rows = ids.map((leadId) => ({
    tenant_id: tenantId,
    agent_name: 'scoring',
    payload: { lead_id: leadId, source },
    status: 'pending',
    priority,
  }));
  const { error } = await client.from('agent_jobs').insert(rows);
  if (error) throw new Error(`scoring_handoff_insert_failed:${error.message}`);
  return { queued: rows.length, skipped: 0 };
}

async function enqueueFgaScoringHandoff(client, tenantId, leadId, options = {}) {
  if (!leadId) throw new Error('scoring_handoff_missing_lead_id');
  if (tenantId !== FGA_TENANT_ID) {
    return { queued: false, reason: 'customer_tenant_unchanged' };
  }
  const source = options.source || 'prospecting_handoff';
  const { error } = await client.from('agent_jobs').insert({
    tenant_id: tenantId,
    agent_name: 'scoring',
    payload: { lead_id: leadId, source },
    status: 'pending',
    priority: options.priority || 7,
  });
  if (error) throw new Error(`scoring_handoff_insert_failed:${error.message}`);
  return { queued: true };
}

/**
 * Hand newly scored, never-contacted FGA prospects to the email drafter.
 *
 * The handoff is idempotent against both current email sequences and an
 * already pending/processing exact-lead outreach job. `skip_send_handoff`
 * keeps discovery ownership separate from provider dispatch: the scheduled
 * auto-outreach windows still rank reviewed restarts first and enforce every
 * cap, suppression, identity, quality and deliverability gate.
 */
async function enqueueFgaOutreachHandoffs(client, tenantId, leadIds, {
  source = 'scoring_handoff',
  priority = 7,
} = {}) {
  if (tenantId !== FGA_TENANT_ID) {
    return { queued: 0, skipped: uniqueIds(leadIds).length, reason: 'customer_tenant_unchanged' };
  }
  const ids = uniqueIds(leadIds);
  if (!ids.length) return { queued: 0, skipped: 0 };

  const [
    { data: sequences, error: sequenceError },
    { data: jobs, error: jobError },
    inventory,
    dailyTarget,
  ] = await Promise.all([
    client.from('outreach_sequences')
      .select('lead_id')
      .eq('tenant_id', tenantId)
      .eq('sequence_type', 'email')
      .in('sequence_status', ['draft', 'approved', 'sending', 'sent'])
      .in('lead_id', ids)
      .limit(2000),
    client.from('agent_jobs')
      .select('payload')
      .eq('tenant_id', tenantId)
      .eq('agent_name', 'outreach')
      .in('status', ['pending', 'processing'])
      .limit(2000),
    countActionableDrafts(client, { tenantId }),
    readDailyTarget(client, { tenantId }),
  ]);
  if (sequenceError) throw new Error(`outreach_handoff_sequence_read_failed:${sequenceError.message}`);
  if (jobError) throw new Error(`outreach_handoff_job_read_failed:${jobError.message}`);
  if (inventory.error) throw new Error(`outreach_handoff_inventory_read_failed:${inventory.error}`);

  const alreadySequenced = new Set((sequences || []).map((row) => String(row.lead_id)));
  const alreadyQueued = new Set((jobs || []).map((row) => row.payload?.lead_id).filter(Boolean).map(String));
  const candidates = ids.filter((id) => !alreadySequenced.has(id) && !alreadyQueued.has(id));
  const inventoryTarget = draftInventoryTarget(dailyTarget.target);
  const committed = Number(inventory.actionable || 0) + queuedDraftCapacity(jobs || []);
  const available = Math.max(0, inventoryTarget - committed);
  const selected = candidates.slice(0, available);
  const capacityReceipt = {
    inventory_target: inventoryTarget,
    actionable_drafts: Number(inventory.actionable || 0),
    queued_draft_capacity: queuedDraftCapacity(jobs || []),
    deferred_for_capacity: Math.max(0, candidates.length - selected.length),
  };
  if (!selected.length) return { queued: 0, skipped: ids.length, ...capacityReceipt };

  const rows = selected.map((leadId) => ({
    tenant_id: tenantId,
    agent_name: 'outreach',
    payload: {
      lead_id: leadId,
      limit: 1,
      mode: 'email_only',
      skip_send_handoff: true,
      source,
    },
    status: 'pending',
    priority,
  }));
  const { error } = await client.from('agent_jobs').insert(rows);
  if (error) throw new Error(`outreach_handoff_insert_failed:${error.message}`);
  return { queued: rows.length, skipped: ids.length - rows.length, ...capacityReceipt };
}

module.exports = {
  enqueueFgaScoringHandoff,
  enqueueFgaScoringHandoffs,
  enqueueFgaOutreachHandoffs,
  draftInventoryDays,
  draftInventoryTarget,
  queuedDraftCapacity,
};
