/**
 * First Gen Automate — System Monitor Agent
 *
 * Platform-wide infrastructure & dependency probe. Runs on a cron a few times a
 * day and actively HITS each external dependency (Serper, Anthropic, Gemini,
 * Telnyx, Buffer) plus the platform's own services (Supabase, API, worker).
 *
 * Why this exists: agents catch dependency failures as console.warn and keep
 * going, so an out-of-credits Serper key or a revoked Anthropic key looks like
 * a "successful" run. Lead-gen silently stalled for ~2 weeks because nothing
 * probed the dependency itself. This agent closes that gap — it calls
 * checkPlatformHealth() which probes every dependency, persists the result to
 * platform_health_checks, and emails a CRITICAL alert the moment anything is
 * down. The Agent Hub admin page reads the same persisted history.
 *
 * Platform-only: identical guard to platform-daily-digest. Skips for every
 * non-platform tenant (the scheduler enqueues module '*' agents per tenant).
 */

const { createLogger } = require('../../core/logger');
const { checkPlatformHealth } = require('../../core/monitoring');
const { FGA_TENANT_ID } = require('../../core/config');

async function run(tenant, _payload = {}) {
  const log = createLogger('system-monitor', tenant.slug);

  const isPlatform =
    tenant.id === FGA_TENANT_ID ||
    tenant.slug === 'platform' ||
    tenant.slug === 'fga' ||
    tenant.tier === 'platform' ||
    tenant.is_platform === true;
  if (!isPlatform) {
    return { success: true, skipped: true, reason: 'not platform tenant' };
  }

  // checkPlatformHealth probes each dependency, persists to
  // platform_health_checks (best-effort), and fires sendCriticalAlert() for any
  // service that is down — so the alerting is fully handled inside.
  const results = await checkPlatformHealth();

  const down = results.filter(r => r.status === 'down');
  const degraded = results.filter(r => r.status === 'degraded');

  log.info('System monitor sweep complete', {
    healthy: results.length - down.length - degraded.length,
    degraded: degraded.length,
    down: down.length,
    downServices: down.map(d => d.service),
  });

  return {
    success: true,
    checked: results.length,
    down: down.map(d => ({ service: d.service, error: d.error_message })),
    degraded: degraded.map(d => d.service),
  };
}

module.exports = run;
