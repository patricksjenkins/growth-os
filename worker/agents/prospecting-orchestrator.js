/**
 * First Gen Automate — Prospecting Orchestrator Agent
 *
 * Coordinates and reports on the end-to-end prospecting engine so the separate
 * agents (prospecting → enrichment → scoring → outreach → drip → replies) read
 * as one connected machine. Each run it builds the funnel + Next Best Actions +
 * stall alerts and persists ONE growth_engine_snapshots row that the Command
 * Center reads cheaply.
 *
 * Hard guarantees (mirrors operations-guardian): platform/FGA-only, NEVER sends,
 * NEVER calls a paid API (rules-based), idempotent per run, never self-triggers.
 * It does NOT remediate — agent-level remediation stays with operations-guardian;
 * this agent only surfaces what the owner should do next.
 */

const { createLogger } = require('../../core/logger');
const { getServiceClient } = require('../../db/client');
const { FGA_TENANT_ID } = require('../../core/config');
const { buildSnapshot, currentWeekStart } = require('../../core/growth/orchestrator');

async function run(tenant, _payload = {}) {
  const log = createLogger('prospecting-orchestrator', tenant.slug);

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
    const db = getServiceClient();
    const snapshot = await buildSnapshot(db, tenant);

    // Persist the snapshot (the dashboard reads the latest row).
    const { error: snapErr } = await db.from('growth_engine_snapshots').insert({
      tenant_id: tenant.id,
      focus: snapshot.focus,
      funnel: snapshot.funnel,
      stage_counts: snapshot.stage_counts,
      next_actions: snapshot.next_actions,
      alerts: snapshot.alerts,
    });
    if (snapErr) throw new Error(`snapshot insert failed: ${snapErr.message}`);

    // Ensure a weekly focus row exists (status 'recommended' — NEVER auto-activates).
    const weekStart = currentWeekStart();
    const { data: existing } = await db.from('growth_campaign_focus')
      .select('id').eq('tenant_id', tenant.id).eq('week_start', weekStart).limit(1).maybeSingle();
    if (!existing) {
      await db.from('growth_campaign_focus').insert({
        tenant_id: tenant.id,
        week_start: weekStart,
        vertical: snapshot.focus.vertical,
        geography: snapshot.focus.geography,
        angle: snapshot.focus.angle,
        status: 'recommended',
        rationale: 'Derived from the current prospecting rotation. Approve to lock this week\'s focus.',
        created_by: 'prospecting-orchestrator',
      });
    }

    const summary = {
      success: true,
      snapshot_written: true,
      next_actions: snapshot.next_actions.length,
      alerts: snapshot.alerts.length,
      new_this_week: snapshot.funnel.new_this_week,
      drafts_to_review: snapshot.funnel.drafts_to_review,
    };
    log.info('Prospecting orchestrator sweep complete', summary);
    return summary;
  } catch (err) {
    // A reporting agent that crashes is itself a silent failure — log loudly,
    // return cleanly so the worker is never taken down.
    log.error(`Prospecting orchestrator failed: ${err.message}`, err);
    return { success: false, error: err.message };
  }
}

module.exports = run;
