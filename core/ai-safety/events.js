/**
 * AI Safety — Event Log + Alert Dedup/Cooldown (Phase 13 + Phase 14)
 *
 * One place to record everything the safety system observes: threshold
 * breaches, would-block decisions, duplicate-job detections, untracked calls,
 * large batches, retry excess, switch changes, and alerts.
 *
 * Alert dedup: repeated alerts for the SAME unresolved condition are
 * suppressed within a cooldown window (default 60 min) using a dedup_key, so
 * the owner isn't paged 100 times for one runaway.
 */

'use strict';

const dbc = require('../../db/client');
const getServiceClient = () => dbc.getServiceClient();
const { flags } = require('./flags');
const { createLogger } = require('../logger');
const { FGA_TENANT_ID } = require('../config');

const log = createLogger('ai-safety-events');

const ALERT_COOLDOWN_MIN = Number(process.env.AI_ALERT_COOLDOWN_MIN || 60);

/**
 * Record a safety event. Best-effort, never throws.
 * @param {Object} evt
 * @returns {Promise<{logged: boolean}>}
 */
async function logEvent(evt = {}) {
  if (!flags.trackingEnabled() && !flags.monitorMode()) return { logged: false };
  const row = {
    tenant_id: evt.tenantId || null,
    event_type: evt.eventType || 'info',
    severity: evt.severity || 'info',
    rule: evt.rule || null,
    scope: evt.scope || null,
    scope_value: evt.scopeValue != null ? String(evt.scopeValue) : null,
    // enforced=false means monitor-only (logged, NOT blocked).
    enforced: evt.enforced === true,
    agent_name: evt.agentName || null,
    job_id: evt.jobId || null,
    lead_id: evt.leadId || null,
    detail: evt.detail || {},
    dedup_key: evt.dedupKey || null,
  };
  try {
    const db = getServiceClient();
    const { error } = await db.from('ai_safety_events').insert(row);
    if (error) { log.warn(`logEvent skipped: ${error.message}`); return { logged: false }; }
    return { logged: true };
  } catch (err) {
    log.warn(`logEvent failed (non-fatal): ${err.message}`);
    return { logged: false };
  }
}

/**
 * Should this alert fire, or is it within the cooldown of an identical recent
 * alert? Returns true if it's clear to alert (and records nothing — caller
 * logs the alert event). Best-effort; on error returns true (fail-open for
 * visibility — better a duplicate alert than a silent miss).
 */
async function shouldAlert(dedupKey) {
  if (!flags.alertsEnabled()) return false;
  if (!dedupKey) return true;
  try {
    const db = getServiceClient();
    const sinceIso = new Date(Date.now() - ALERT_COOLDOWN_MIN * 60_000).toISOString();
    const { count, error } = await db
      .from('ai_safety_events')
      .select('id', { count: 'exact', head: true })
      .eq('event_type', 'alert')
      .eq('dedup_key', dedupKey)
      .gte('created_at', sinceIso);
    if (error) return true;
    return (count || 0) === 0;
  } catch {
    return true;
  }
}

/**
 * Deliver an alert to the platform owner through the EXISTING notifications
 * feed (same table the notification-push agent already delivers). Best-effort;
 * never throws. Only warning/critical reach the owner — 'info' stays in the
 * safety event log to avoid alarm fatigue. Dedup is already enforced by the
 * caller's shouldAlert() cooldown, so this won't spam.
 */
async function _deliverToOwner({ severity, rule, tenantId, agentName, detail, dedupKey }) {
  if (severity !== 'warning' && severity !== 'critical') return;
  try {
    const db = getServiceClient();
    const title = `AI Safety: ${rule || 'alert'}`;
    const parts = [];
    if (agentName) parts.push(`agent=${agentName}`);
    if (detail && detail.count != null && detail.limit != null) parts.push(`${detail.count} vs limit ${detail.limit}`);
    if (tenantId) parts.push(`tenant=${tenantId}`);
    const message = `${severity.toUpperCase()} — ${rule || 'AI safety event'}${parts.length ? ' (' + parts.join(', ') + ')' : ''}. Monitor mode: nothing was blocked. Review the AI Safety dashboard.`;
    await db.from('notifications').insert({
      // Platform-owner alerts land on the FGA tenant's feed.
      tenant_id: FGA_TENANT_ID,
      category: 'ai_safety_alert',
      priority: severity === 'critical' ? 'high' : 'medium',
      title,
      message,
      metadata: { rule, severity, agentName: agentName || null, sourceTenant: tenantId || null, dedupKey, ...detail },
      status: 'pending',
    });
  } catch (err) {
    log.warn(`alert owner-delivery skipped (non-fatal): ${err.message}`);
  }
}

/**
 * Fire an alert with dedup. Records a durable 'alert' event AND (for
 * warning/critical) delivers to the owner notifications feed when not
 * suppressed. Never throws.
 * @returns {Promise<{alerted: boolean, suppressed?: boolean, delivered?: boolean}>}
 */
async function alert({ dedupKey, severity = 'warning', rule, tenantId, agentName, detail = {} }) {
  if (!flags.alertsEnabled()) return { alerted: false };
  const clear = await shouldAlert(dedupKey);
  if (!clear) return { alerted: false, suppressed: true };
  await logEvent({
    eventType: 'alert', severity, rule, tenantId, agentName, detail, dedupKey,
  });
  await _deliverToOwner({ severity, rule, tenantId, agentName, detail, dedupKey });
  log.warn(`ALERT [${severity}] ${rule || ''} ${dedupKey || ''}`);
  return { alerted: true, delivered: severity === 'warning' || severity === 'critical' };
}

module.exports = { logEvent, shouldAlert, alert, ALERT_COOLDOWN_MIN };
