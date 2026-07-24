'use strict';

const { createLogger } = require('../logger');
const { flags } = require('./feature-flags');

const log = createLogger('job-outcomes');
let lastWarningAt = 0;

function warnAtMostOncePerMinute(detail) {
  const now = Date.now();
  if (now - lastWarningAt < 60_000) return;
  lastWarningAt = now;
  log.warn('Outcome observation skipped:', detail);
}

/**
 * Best-effort, additive observability. Missing tables or transient database
 * errors can never fail an existing tenant job.
 */
async function recordJobOutcome({ jobId, tenantId, agentName, envelope }) {
  if (!flags.outcomeObservability()) return { recorded: false, reason: 'disabled' };
  if (!jobId || !tenantId || !agentName || !envelope) {
    return { recorded: false, reason: 'incomplete_metadata' };
  }

  try {
    // Resolve at call time so tests and local tools can safely inject a client.
    const { getServiceClient } = require('../../db/client');
    const db = getServiceClient();
    const row = {
      job_id: jobId,
      tenant_id: tenantId,
      agent_name: agentName,
      schema_version: envelope.schema_version,
      contract_source: envelope.contract_source,
      execution_state: envelope.execution_state,
      result_state: envelope.result_state,
      output_state: envelope.output_state,
      quality_state: envelope.quality_state,
      delivery_state: envelope.delivery_state,
      business_outcome_state: envelope.business_outcome_state,
      reason_code: envelope.reason_code,
      evidence: envelope.evidence,
      duration_ms: envelope.duration_ms,
      observed_at: envelope.observed_at,
    };
    const { error } = await db
      .from('agent_job_outcomes')
      .upsert(row, { onConflict: 'job_id' });

    if (error) {
      // Expected during code-before-migration rollout. Avoid one warning per
      // tenant job while the additive table is not installed yet.
      if (error.code === '42P01') return { recorded: false, reason: 'table_missing' };
      warnAtMostOncePerMinute(error.code || error.message || 'database_error');
      return { recorded: false, reason: 'database_error' };
    }
    return { recorded: true };
  } catch (error) {
    warnAtMostOncePerMinute(error.code || error.name || 'unexpected_error');
    return { recorded: false, reason: 'unexpected_error' };
  }
}

module.exports = { recordJobOutcome };
