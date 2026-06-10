/**
 * AI Safety — Provider Call Guard (orchestrator)
 *
 * The single entrypoint the provider wrappers (integrations/claude.js,
 * integrations/gemini.js) call around every automated AI request.
 *
 *   const decision = await guard.beforeCall(meta);   // monitor: always allow
 *   ... make provider call ...
 *   await guard.afterCall(meta, { usage, outcome }); // record + evaluate
 *
 * HARD CONTRACT: nothing here may throw into the provider call path, and in
 * Release 1 beforeCall ALWAYS returns { allow: true }. Blocking only happens
 * if an enforcement flag is explicitly enabled AND a matching switch is open.
 */

'use strict';

const { flags, thresholds } = require('./flags');
const switches = require('./switches');
const tracker = require('./usage-tracker');
const events = require('./events');
const { createLogger } = require('../logger');

const log = createLogger('ai-guard');

/**
 * Called immediately before a provider request.
 * @returns {Promise<{allow: boolean, monitor?: object}>}
 */
async function beforeCall(meta = {}) {
  try {
    if (!flags.trackingEnabled() && !flags.monitorMode()) return { allow: true };

    const decision = await switches.evaluate(meta);
    if (decision.blocked) {
      // Enforcement is ON and a switch is open for this scope.
      await events.logEvent({
        eventType: 'would_block', severity: 'critical', rule: `${decision.kind}_open`,
        scope: decision.scope, scopeValue: decision.scopeValue, enforced: true,
        tenantId: meta.tenantId, agentName: meta.agentName, jobId: meta.jobId,
        detail: { reason: decision.reason, provider: meta.provider },
      });
      return { allow: false, reason: decision.reason, monitor: decision };
    }

    if (decision.open && decision.open.length) {
      // Switch open but enforcement OFF — monitor-only record of would-block.
      await events.logEvent({
        eventType: 'would_block', severity: 'warning', rule: `${decision.open[0].kind}_open`,
        scope: decision.open[0].scope, scopeValue: decision.open[0].scope_value, enforced: false,
        tenantId: meta.tenantId, agentName: meta.agentName, jobId: meta.jobId,
        detail: { note: 'enforcement_disabled', provider: meta.provider },
      });
    }
    return { allow: true, monitor: decision };
  } catch (err) {
    // Fail-open: never block a call because the guard errored.
    log.warn(`beforeCall error (allowing call): ${err.message}`);
    return { allow: true };
  }
}

/**
 * Called after a provider request resolves or fails. Records the usage event
 * and kicks off (fire-and-forget) threshold evaluation so the call path adds
 * no extra latency.
 */
async function afterCall(meta = {}, result = {}) {
  try {
    await tracker.recordUsage({
      ...meta,
      inputTokens: result.usage?.input_tokens ?? result.inputTokens,
      outputTokens: result.usage?.output_tokens ?? result.outputTokens,
      outcome: result.outcome || 'success',
      error: result.error,
      attempt: meta.attempt || 1,
    });
  } catch (err) {
    log.warn(`afterCall record error (non-fatal): ${err.message}`);
  }
  // Threshold evaluation must never delay or break the caller.
  setImmediate(() => { evaluateThresholds(meta).catch(() => {}); });
}

/**
 * Evaluate per-tenant / per-agent / per-job / per-lead call counts against the
 * configured thresholds. In monitor mode every breach is LOGGED (enforced:
 * false) and alerted with dedup — nothing is blocked.
 * @returns {Promise<string[]>} list of breached rule names
 */
async function evaluateThresholds(meta = {}) {
  if (!flags.monitorMode() && !flags.hardLimits()) return [];
  const breached = [];
  const enforced = flags.hardLimits();

  const checks = [];
  if (meta.tenantId) {
    checks.push(['tenant_per_minute', () => tracker.countCalls({ minutes: 1, tenantId: meta.tenantId }), thresholds.maxCallsPerTenantPerMinute(), 'tenant', meta.tenantId]);
    checks.push(['tenant_per_hour', () => tracker.countCalls({ minutes: 60, tenantId: meta.tenantId }), thresholds.maxCallsPerTenantPerHour(), 'tenant', meta.tenantId]);
    checks.push(['tenant_per_day', () => tracker.countCalls({ minutes: 1440, tenantId: meta.tenantId }), thresholds.maxCallsPerTenantPerDay(), 'tenant', meta.tenantId]);
  }
  if (meta.agentName) {
    checks.push(['agent_per_hour', () => tracker.countCalls({ minutes: 60, agentName: meta.agentName }), thresholds.maxCallsPerAgentPerHour(), 'agent', meta.agentName]);
    checks.push(['agent_per_day', () => tracker.countCalls({ minutes: 1440, agentName: meta.agentName }), thresholds.maxCallsPerAgentPerDay(), 'agent', meta.agentName]);
  }
  if (meta.jobId) {
    checks.push(['calls_per_job', () => tracker.countCalls({ minutes: 1440, jobId: meta.jobId }), thresholds.maxCallsPerJob(), 'job', meta.jobId]);
  }
  if (meta.leadId) {
    // Repeated calls for the SAME lead — a key runaway-loop signal.
    checks.push(['calls_per_lead', () => tracker.countCalls({ minutes: 60, leadId: meta.leadId }), thresholds.maxCallsPerJob() * 3, 'lead', meta.leadId]);
  }

  for (const [rule, counter, limit, scope, scopeValue] of checks) {
    try {
      if (!limit || limit <= 0) continue;
      const count = await counter();
      if (count > limit) {
        breached.push(rule);
        await events.logEvent({
          eventType: 'threshold_exceeded', severity: enforced ? 'critical' : 'warning',
          rule, scope, scopeValue, enforced,
          tenantId: meta.tenantId, agentName: meta.agentName, jobId: meta.jobId, leadId: meta.leadId,
          detail: { count, limit, provider: meta.provider, would_block: !enforced },
        });
        await events.alert({
          dedupKey: `threshold:${rule}:${scope}:${scopeValue}`,
          severity: enforced ? 'critical' : 'warning',
          rule, tenantId: meta.tenantId, agentName: meta.agentName,
          detail: { count, limit, scope, scopeValue },
        });
      }
    } catch { /* per-check best-effort */ }
  }
  return breached;
}

module.exports = { beforeCall, afterCall, evaluateThresholds };
