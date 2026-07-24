'use strict';

const STATES = Object.freeze({
  execution: new Set(['completed', 'failed']),
  result: new Set(['succeeded', 'failed', 'unknown']),
  output: new Set(['produced', 'no_output', 'no_op', 'unknown']),
  quality: new Set(['accepted', 'rejected', 'unverified', 'unknown']),
  delivery: new Set(['delivered', 'not_delivered', 'not_applicable', 'unknown']),
  business: new Set(['achieved', 'not_achieved', 'not_applicable', 'unverified', 'unknown']),
});

function safeState(group, value, fallback) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return STATES[group].has(normalized) ? normalized : fallback;
}

function cleanEvidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const evidence = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === null || ['string', 'number', 'boolean'].includes(typeof item)) {
      evidence[key] = item;
    }
  }
  return evidence;
}

/**
 * Translate a handler return into a versioned outcome envelope without
 * pretending that a completed function call proved useful business output.
 *
 * New agents should return an `outcome_contract` object. Legacy returns are
 * classified conservatively: explicit success:false is a result failure;
 * everything else remains unverified rather than being painted green.
 */
function buildOutcomeEnvelope({ result, error, durationMs } = {}) {
  const declared = result && typeof result === 'object' && !Array.isArray(result)
    ? result.outcome_contract
    : null;
  const hasDeclared = declared && typeof declared === 'object' && !Array.isArray(declared);
  const explicitFailure = Boolean(error) ||
    (result && typeof result === 'object' && result.success === false);
  const explicitNoOp = Boolean(
    result && typeof result === 'object' &&
    (result.skipped === true || result.no_op === true || result.skipped_reason)
  );

  const envelope = {
    schema_version: 1,
    contract_source: hasDeclared ? 'declared' : 'legacy_adapter',
    execution_state: error ? 'failed' : 'completed',
    result_state: explicitFailure ? 'failed' : (
      hasDeclared
        ? safeState('result', declared.result_state, 'unknown')
        : (result === undefined ? 'unknown' : 'succeeded')
    ),
    output_state: hasDeclared
      ? safeState('output', declared.output_state, 'unknown')
      : (explicitNoOp ? 'no_op' : 'unknown'),
    quality_state: hasDeclared
      ? safeState('quality', declared.quality_state, 'unknown')
      : 'unverified',
    delivery_state: hasDeclared
      ? safeState('delivery', declared.delivery_state, 'unknown')
      : 'unknown',
    business_outcome_state: hasDeclared
      ? safeState('business', declared.business_outcome_state, 'unknown')
      : 'unverified',
    reason_code: hasDeclared && typeof declared.reason_code === 'string'
      ? declared.reason_code.slice(0, 120)
      : (
        error && typeof error.reasonCode === 'string'
          ? error.reasonCode.slice(0, 120) :
        error ? 'handler_threw' :
          explicitFailure ? 'handler_returned_failure' :
            explicitNoOp ? 'legacy_explicit_no_op' :
              'legacy_result_unverified'
      ),
    evidence: hasDeclared ? cleanEvidence(declared.evidence) : {},
    duration_ms: Number.isFinite(durationMs) && durationMs >= 0 ? Math.round(durationMs) : null,
    observed_at: new Date().toISOString(),
  };

  if (error) {
    envelope.evidence.error_name = error.name || 'Error';
    Object.assign(envelope.evidence, cleanEvidence(error.evidence));
  }

  return envelope;
}

module.exports = { buildOutcomeEnvelope, STATES };
