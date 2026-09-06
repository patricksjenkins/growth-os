'use strict';

const crypto = require('crypto');

const PIPELINE_STAGES = Object.freeze([
  'discovered',
  'contact_verified',
  'qualified',
  'drafted',
  'provider_accepted',
  'delivered',
  'human_reply',
  'warm',
  'owner_accepted',
  'demo_held',
  'proposal',
  'won',
]);

function eventIdempotencyKey({ tenantId, leadId, eventType, sourceId }) {
  const stable = [tenantId, leadId || '-', eventType, sourceId || '-'].join(':');
  return crypto.createHash('sha256').update(stable).digest('hex');
}

function sanitizeEvidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  // Evidence may describe provider/status decisions, but the canonical ledger
  // must not become a copy of message bodies, emails, phone numbers or secrets.
  const denied = /email|phone|recipient|body|html|token|secret|key|address/i;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !denied.test(key)));
}

function growthEventRow({
  tenantId,
  leadId = null,
  eventType,
  stage = null,
  sourceSystem,
  sourceId = null,
  occurredAt = new Date().toISOString(),
  actor = 'system',
  evidence = {},
  experimentKey = null,
  icpVersion = null,
  scoreVersion = null,
  messageVersion = null,
  correlationId = null,
  idempotencyKey = null,
}) {
  if (!tenantId) throw new Error('growth_event_tenant_required');
  if (!eventType) throw new Error('growth_event_type_required');
  if (!sourceSystem) throw new Error('growth_event_source_required');
  if (stage && !PIPELINE_STAGES.includes(stage)) throw new Error(`invalid_growth_stage:${stage}`);

  const key = idempotencyKey || eventIdempotencyKey({ tenantId, leadId, eventType, sourceId });
  return {
    tenant_id: tenantId,
    lead_id: leadId,
    event_type: eventType,
    stage,
    source_system: sourceSystem,
    source_id: sourceId,
    occurred_at: occurredAt,
    actor,
    evidence: sanitizeEvidence(evidence),
    experiment_key: experimentKey,
    icp_version: icpVersion,
    score_version: scoreVersion,
    message_version: messageVersion,
    correlation_id: correlationId,
    idempotency_key: key,
  };
}

async function recordGrowthEvent(db, input) {
  const row = growthEventRow(input);
  const { data, error } = await db.from('growth_events')
    .upsert(row, { onConflict: 'tenant_id,idempotency_key', ignoreDuplicates: true })
    .select('id, tenant_id, lead_id, event_type, stage, occurred_at')
    .maybeSingle();
  if (error) throw new Error(`growth_event_write_failed:${error.message}`);
  return data || null;
}

module.exports = {
  PIPELINE_STAGES,
  eventIdempotencyKey,
  sanitizeEvidence,
  growthEventRow,
  recordGrowthEvent,
};
