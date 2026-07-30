/**
 * Growth OS — Account Management System
 * Health scoring, lifecycle management, and weekly digest generation
 */

const { db } = require('../db/client');
const { createLogger } = require('./logger');
const log = createLogger('account-mgmt');

// ---------------------------------------------------------------------------
// Health Score Calculation
// ---------------------------------------------------------------------------

/**
 * Calculate health score for a tenant account
 * Returns green/yellow/red based on usage, leads, support, and payment
 *
 * @param {string} tenantId - Tenant UUID
 * @returns {Object} { score: 'green'|'yellow'|'red', metrics, reasons }
 */
async function calculateHealthScore(tenantId) {
  const now = new Date();
  const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  const reasons = [];
  let points = 0;
  const maxPoints = 4;

  // 1. App usage — photo uploads in last 7 days
  const { data: photos, error: photoErr } = await db
    .from('job_photos')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .gte('created_at', sevenDaysAgo);

  const photoCount = photos?.length ?? 0;
  if (!photoErr && photoCount > 0) {
    points += 1;
  } else {
    reasons.push('No photo uploads in last 7 days');
  }

  // 2. Content approvals in last 7 days
  const { data: approvals, error: approvalErr } = await db
    .from('content_queue')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('status', 'approved')
    .gte('updated_at', sevenDaysAgo);

  const approvalCount = approvals?.length ?? 0;
  if (!approvalErr && approvalCount > 0) {
    points += 1;
  } else {
    reasons.push('No content approvals in last 7 days');
  }

  // 3. Lead volume — any new leads in last 7 days
  const { data: leads, error: leadErr } = await db
    .from('leads')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .gte('created_at', sevenDaysAgo);

  const leadCount = leads?.length ?? 0;
  if (!leadErr && leadCount > 0) {
    points += 1;
  } else {
    reasons.push('No new leads in last 7 days');
  }

  // 4. Payment status — check for recent failed payments
  const { data: alerts } = await db
    .from('account_alerts')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('alert_type', 'payment_failed')
    .eq('resolved', false)
    .limit(1);

  if (!alerts || alerts.length === 0) {
    points += 1;
  } else {
    reasons.push('Unresolved payment failure');
  }

  // Score thresholds
  let score;
  if (points >= 3) {
    score = 'green';
  } else if (points >= 2) {
    score = 'yellow';
  } else {
    score = 'red';
  }

  const metrics = {
    photoUploads7d: photoCount,
    contentApprovals7d: approvalCount,
    newLeads7d: leadCount,
    hasPaymentIssue: (alerts && alerts.length > 0),
    points,
    maxPoints,
  };

  // Log health score to history
  try {
    await db.from('account_health_log').insert({
      tenant_id: tenantId,
      health_score: score,
      metrics,
    });
  } catch (logErr) {
    log.warn(`Failed to log health score for ${tenantId}: ${logErr.message}`);
  }

  return { score, metrics, reasons };
}

// ---------------------------------------------------------------------------
// Account Status
// ---------------------------------------------------------------------------

/**
 * Get full account profile for a tenant
 * @param {string} tenantId - Tenant UUID
 * @returns {Object} Full account status
 */
async function getAccountStatus(tenantId) {
  // Fetch tenant base info
  const { data: tenant, error: tenantErr } = await db
    .from('tenants')
    .select('*')
    .eq('id', tenantId)
    .single();

  if (tenantErr || !tenant) {
    throw new Error(`Tenant not found: ${tenantId}`);
  }

  // Fetch config for tier/billing info
  const { data: config } = await db
    .from('tenant_config')
    .select('key, value')
    .eq('tenant_id', tenantId);

  const configMap = {};
  for (const c of (config || [])) {
    configMap[c.key] = c.value;
  }

  // Calculate current health
  const health = await calculateHealthScore(tenantId);

  // Recent lifecycle events
  const { data: events } = await db
    .from('lifecycle_events')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(5);

  // Active alerts
  const { data: alerts } = await db
    .from('account_alerts')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('resolved', false)
    .order('created_at', { ascending: false });

  return {
    tenant: {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      status: tenant.status,
      createdAt: tenant.created_at,
    },
    tier: configMap.tier || 'growth',
    billing: {
      stripeCustomerId: configMap.stripe_customer_id || null,
      subscriptionStatus: configMap.subscription_status || 'unknown',
    },
    health,
    onboardingStatus: configMap.onboarding_status || 'unknown',
    recentEvents: events || [],
    activeAlerts: alerts || [],
  };
}

// ---------------------------------------------------------------------------
// Batch Account Check
// ---------------------------------------------------------------------------

/**
 * Check all active tenant accounts, calculate health, flag yellows/reds
 * @returns {Object} Summary of all account health statuses
 */
async function checkAllAccounts() {
  const { data: tenants, error } = await db
    .from('tenants')
    .select('id, name, slug, status')
    .eq('status', 'active');

  if (error) throw error;

  const results = { green: [], yellow: [], red: [], errors: [] };

  for (const tenant of (tenants || [])) {
    try {
      const health = await calculateHealthScore(tenant.id);
      const entry = { tenantId: tenant.id, name: tenant.name, slug: tenant.slug, ...health };
      results[health.score].push(entry);

      // Create alert for red accounts
      if (health.score === 'red') {
        await db.from('account_alerts').insert({
          tenant_id: tenant.id,
          alert_type: 'health_red',
          message: `Account health is RED. Issues: ${health.reasons.join('; ')}`,
        });
      }

      // Create alert for yellow accounts that were previously green
      if (health.score === 'yellow') {
        await db.from('account_alerts').insert({
          tenant_id: tenant.id,
          alert_type: 'health_yellow',
          message: `Account health dropped to YELLOW. Issues: ${health.reasons.join('; ')}`,
        });
      }
    } catch (err) {
      log.error(`Failed to check account ${tenant.slug}: ${err.message}`);
      results.errors.push({ tenantId: tenant.id, name: tenant.name, error: err.message });
    }
  }

  log.info(`Account check complete: ${results.green.length} green, ${results.yellow.length} yellow, ${results.red.length} red`);
  return results;
}

// ---------------------------------------------------------------------------
// Weekly Digest
// ---------------------------------------------------------------------------

/**
 * Generate a weekly summary of all accounts
 * @returns {Object} Weekly digest data
 */
async function generateWeeklyDigest() {
  const accountHealth = await checkAllAccounts();

  // Get MRR from finance_entries (subscription income this month)
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];

  const { data: incomeData } = await db
    .from('finance_entries')
    .select('amount')
    .eq('entry_type', 'income')
    .gte('date', monthStart)
    .lte('date', monthEnd);

  const monthlyRevenue = (incomeData || []).reduce(
    (sum, e) => sum + parseFloat(e.amount || 0), 0
  );

  // New clients this week
  const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: newTenants } = await db
    .from('tenants')
    .select('id, name')
    .gte('created_at', weekAgo);

  // Total active clients
  const { data: activeTenants } = await db
    .from('tenants')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'active');

  const digest = {
    generatedAt: now.toISOString(),
    mrr: monthlyRevenue,
    totalActiveClients: activeTenants?.length ?? 0,
    newClientsThisWeek: (newTenants || []).map(t => t.name),
    healthDistribution: {
      green: accountHealth.green.length,
      yellow: accountHealth.yellow.length,
      red: accountHealth.red.length,
    },
    alerts: {
      yellowAccounts: accountHealth.yellow.map(a => ({ name: a.name, reasons: a.reasons })),
      redAccounts: accountHealth.red.map(a => ({ name: a.name, reasons: a.reasons })),
    },
  };

  log.info(`Weekly digest generated: MRR $${digest.mrr}, ${digest.totalActiveClients} active clients`);
  return digest;
}

// ---------------------------------------------------------------------------
// Lifecycle Transitions
// ---------------------------------------------------------------------------

/**
 * Manage account lifecycle transitions
 * onboarding -> active -> at_risk -> churned
 *
 * @param {string} tenantId - Tenant UUID
 * @param {string} newStatus - Target status
 * @param {string} reason - Reason for transition
 * @returns {Object} Transition result
 */
async function handleLifecycleTransition(tenantId, newStatus, reason = '') {
  const validStatuses = ['onboarding', 'active', 'at_risk', 'churned'];
  if (!validStatuses.includes(newStatus)) {
    throw new Error(`Invalid status "${newStatus}". Must be one of: ${validStatuses.join(', ')}`);
  }

  // Get current status
  const { data: tenant, error } = await db
    .from('tenants')
    .select('status, name')
    .eq('id', tenantId)
    .single();

  if (error || !tenant) throw new Error(`Tenant not found: ${tenantId}`);

  const fromStatus = tenant.status;

  // Validate transition path.
  //
  // `onboarding_intake_complete` was missing here (added 2026-07-30). The
  // wizard sets that status when the customer finishes intake
  // (api/routes/tenant.js), so a tenant that completed the wizard sat in a
  // status with no entry in this map — and `validTransitions[fromStatus]?.
  // includes(...)` on undefined is falsy, so going live threw
  // "Invalid transition: onboarding_intake_complete -> active". The one
  // transition that had to work at the end of onboarding was the one that
  // could not.
  const validTransitions = {
    onboarding: ['onboarding_intake_complete', 'active', 'churned'],
    onboarding_intake_complete: ['active', 'churned'],
    active: ['at_risk', 'churned'],
    at_risk: ['active', 'churned'],
    churned: ['onboarding'], // re-activation
  };

  if (fromStatus === newStatus) {
    return { changed: false, message: `Account already in "${newStatus}" status` };
  }

  if (!validTransitions[fromStatus]?.includes(newStatus)) {
    throw new Error(`Invalid transition: ${fromStatus} -> ${newStatus}`);
  }

  // Update tenant status
  const { error: updateErr } = await db
    .from('tenants')
    .update({ status: newStatus })
    .eq('id', tenantId);

  if (updateErr) throw updateErr;

  // Log lifecycle event
  await db.from('lifecycle_events').insert({
    tenant_id: tenantId,
    from_status: fromStatus,
    to_status: newStatus,
    reason,
  });

  // Trigger automated actions based on transition
  const actions = [];

  if (newStatus === 'active' && fromStatus === 'onboarding') {
    actions.push('send_welcome_complete_email');
    actions.push('enable_all_modules');
    log.info(`${tenant.name}: Onboarding complete, account activated`);
  }

  if (newStatus === 'at_risk') {
    actions.push('send_at_risk_notification');
    actions.push('schedule_check_in_call');
    actions.push('create_account_alert');
    await db.from('account_alerts').insert({
      tenant_id: tenantId,
      alert_type: 'at_risk',
      message: `Account transitioned to at_risk. Reason: ${reason}`,
    });
    log.warn(`${tenant.name}: Account flagged as at-risk — ${reason}`);
  }

  if (newStatus === 'churned') {
    actions.push('send_offboarding_email');
    actions.push('cancel_subscription');
    actions.push('archive_data');
    log.info(`${tenant.name}: Account churned — ${reason}`);
  }

  if (newStatus === 'active' && fromStatus === 'at_risk') {
    actions.push('send_recovery_email');
    actions.push('resolve_at_risk_alerts');
    // Resolve open at_risk alerts
    await db
      .from('account_alerts')
      .update({ resolved: true })
      .eq('tenant_id', tenantId)
      .eq('alert_type', 'at_risk')
      .eq('resolved', false);
    log.info(`${tenant.name}: Account recovered from at-risk`);
  }

  return {
    changed: true,
    from: fromStatus,
    to: newStatus,
    reason,
    triggeredActions: actions,
  };
}

module.exports = {
  calculateHealthScore,
  getAccountStatus,
  checkAllAccounts,
  generateWeeklyDigest,
  handleLifecycleTransition,
};
