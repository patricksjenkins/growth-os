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
const { FGA_TENANT_ID, getConfig } = require('../../core/config');
const { buildSnapshot, currentWeekStart } = require('../../core/growth/orchestrator');
const {
  supersedeStaleDrafts, computeNextActionsForLeads, salesInvariants,
} = require('../../core/sales/coordination');

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

    // --- Sales-department coordination (2026-07-21, additive) --------------
    // Runs BEFORE the snapshot so the funnel reflects post-coordination state.
    // Kill switch: tenant_config sales_coordination_enabled='false'.
    let coordination = { skipped: true };
    if (String(getConfig(tenant, 'sales_coordination_enabled', 'true')) !== 'false') {
      try {
        const stale = await supersedeStaleDrafts(db, tenant.id);
        const sweep = await computeNextActionsForLeads(db, tenant);
        coordination = { ...stale, ...sweep };
      } catch (coordErr) {
        // Coordination must never take down the snapshot the dashboard needs.
        log.error(`Sales coordination sweep failed (non-fatal): ${coordErr.message}`);
        coordination = { error: coordErr.message };
      }
    }

    const snapshot = await buildSnapshot(db, tenant);

    // Sales invariants join the funnel + alerts so the dashboard, mobile, and
    // the daily brief all read the same numbers. no_next_action should be 0
    // right after a sweep — anything else is a coordination defect, surfaced
    // loudly instead of hidden.
    const invariants = await salesInvariants(db, tenant.id);
    snapshot.funnel = { ...snapshot.funnel, ...invariants };
    if (invariants.sales_calls_needed > 0) {
      snapshot.next_actions.unshift({
        id: 'sales_calls', severity: 'action',
        label: `${invariants.sales_calls_needed} prospect${invariants.sales_calls_needed === 1 ? '' : 's'} waiting on a sales call`,
        count: invariants.sales_calls_needed, link: '/admin/pipeline?view=sales-calls',
      });
    }
    if (invariants.owner_actions_overdue > 0) {
      snapshot.alerts.push({
        id: 'owner_actions_overdue', severity: 'urgent',
        label: 'Owner actions overdue',
        detail: `${invariants.owner_actions_overdue} lead(s) have been waiting on you past their due date.`,
      });
    }
    if (invariants.no_next_action > 0 && !coordination.skipped && !coordination.error) {
      snapshot.alerts.push({
        id: 'leads_without_next_action', severity: 'warn',
        label: 'Leads without a next action',
        detail: `${invariants.no_next_action} active lead(s) have no assigned next action after the sweep — coordination defect.`,
      });
    }

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
      coordination,
      sales_calls_needed: snapshot.funnel.sales_calls_needed,
      no_next_action: snapshot.funnel.no_next_action,
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
