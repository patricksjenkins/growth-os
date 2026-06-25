/**
 * First Gen Automate — Operations Guardian Agent
 *
 * Controlled self-healing for FGA's own operational agents. On each scheduled
 * run it detects agent-level problems (failures, stalls, missing business
 * output), applies bounded Level-1-safe fixes automatically (requeue / resume),
 * escalates anything riskier to an owner-approval item, verifies recovery, and
 * records an incident in ops_incidents. The Chief-of-Staff digest and the
 * Agent Hub read those incidents.
 *
 * Platform-only: identical guard to system-monitor / platform-daily-digest.
 * It is never self-triggered (no loop) and calls no paid API — all heavy
 * lifting (detection, diagnosis) is read-only + rules-based; the only action
 * is re-enqueuing through the normal, capped job queue. See core/ops-guardian.
 */

const { createLogger } = require('../../core/logger');
const { runGuardian } = require('../../core/ops-guardian');
const { FGA_TENANT_ID } = require('../../core/config');

async function run(tenant, _payload = {}) {
  const log = createLogger('operations-guardian', tenant.slug);

  const isPlatform =
    tenant.id === FGA_TENANT_ID ||
    tenant.slug === 'platform' ||
    tenant.slug === 'fga' ||
    tenant.tier === 'platform' ||
    tenant.is_platform === true;
  if (!isPlatform) {
    return { success: true, skipped: true, reason: 'not platform tenant' };
  }

  try {
    const summary = await runGuardian();
    log.info('Operations Guardian sweep complete', summary);
    return { success: true, ...summary };
  } catch (err) {
    // The guardian must never take down the worker — a monitoring agent that
    // crashes is itself a silent failure, so log loudly and return cleanly.
    log.error(`Operations Guardian failed: ${err.message}`, err);
    return { success: false, error: err.message };
  }
}

module.exports = run;
