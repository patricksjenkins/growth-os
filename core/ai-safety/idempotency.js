/**
 * AI Safety — Idempotency & Duplicate Detection (Phase 10)
 *
 * Deterministic key for an outreach touch:
 *     tenantId + leadId + campaignId + campaignStage
 *
 * In Release 1 (AI_IDEMPOTENCY_ENFORCEMENT off) detectOutreachDuplicate()
 * only DETECTS and LOGS — it never blocks. This lets us measure how many real
 * duplicates exist before any unique constraint or hard rejection is enabled,
 * exactly as the rollout plan requires (no DB unique constraint until the data
 * is audited).
 */

'use strict';

const crypto = require('crypto');
const dbc = require('../../db/client');
const getServiceClient = () => dbc.getServiceClient();
const { flags } = require('./flags');
const events = require('./events');
const { createLogger } = require('../logger');

const log = createLogger('ai-idempotency');

/**
 * Deterministic idempotency key for an outreach touch.
 */
function outreachKey({ tenantId, leadId, campaignId = 'default', campaignStage = 'initial' }) {
  const raw = `${tenantId || ''}|${leadId || ''}|${campaignId || 'default'}|${campaignStage || 'initial'}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

/**
 * Detect whether the same outreach touch already happened/queued. Best-effort;
 * returns a decision object. Does NOT block in Release 1.
 *
 * Signals checked against outreach_sequences for the same lead + stage:
 *   queued ('approved'/'draft'/'pending'), processing ('sending'), or
 *   completed ('sent').
 *
 * @returns {Promise<{duplicate: boolean, wouldBlock: boolean, key: string, signals: string[]}>}
 */
async function detectOutreachDuplicate(meta = {}) {
  const key = outreachKey(meta);
  const result = { duplicate: false, wouldBlock: false, key, signals: [] };
  if (!meta.tenantId || !meta.leadId) return result;

  try {
    const db = getServiceClient();
    // Look for any prior sequence for this lead in a non-terminal/terminal-sent
    // state. We intentionally read broadly and classify, so this is robust to
    // schema variations in stage naming.
    const { data, error } = await db
      .from('outreach_sequences')
      .select('id, sequence_status, step_number, created_at')
      .eq('tenant_id', meta.tenantId)
      .eq('lead_id', meta.leadId)
      .order('created_at', { ascending: false })
      .limit(10);
    if (error || !data) return result;

    const statuses = data.map((r) => String(r.sequence_status || '').toLowerCase());
    if (statuses.some((s) => ['approved', 'draft', 'pending', 'queued'].includes(s))) result.signals.push('already_queued');
    if (statuses.some((s) => ['sending', 'processing'].includes(s))) result.signals.push('already_processing');
    if (statuses.some((s) => ['sent', 'completed'].includes(s))) result.signals.push('already_sent');
    // 'superseded' (2026-07-21): stale draft retired by the sales orchestrator
    // because the lead left new_lead. Classified as its own signal — it should
    // never look like an open queue slot, but a prior sequence existing is
    // still a duplicate-outreach hint worth counting.
    if (statuses.some((s) => s === 'superseded')) result.signals.push('had_superseded_draft');

    result.duplicate = result.signals.length > 0;

    if (result.duplicate) {
      const enforced = flags.idempotencyEnforcement();
      result.wouldBlock = !enforced; // monitor-mode: would block but doesn't
      await events.logEvent({
        eventType: 'duplicate', severity: enforced ? 'warning' : 'info',
        rule: 'outreach_idempotency', scope: 'lead', scopeValue: meta.leadId, enforced,
        tenantId: meta.tenantId, leadId: meta.leadId,
        detail: { key, signals: result.signals, campaignStage: meta.campaignStage || 'initial', would_block: !enforced },
        dedupKey: `dup:${key}`,
      });
      if (!enforced) log.info(`Duplicate outreach detected (monitor-only): lead=${meta.leadId} signals=${result.signals.join(',')}`);
    }
    return result;
  } catch (err) {
    log.warn(`detectOutreachDuplicate failed (non-fatal): ${err.message}`);
    return result;
  }
}

module.exports = { outreachKey, detectOutreachDuplicate };
