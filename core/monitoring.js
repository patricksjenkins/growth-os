/**
 * Growth OS — Platform Monitoring System
 * Phase 8: Operational Automation & Steady State
 *
 * Checks platform services, tenant health, and sends critical alerts.
 */

const { getServiceClient } = require('../db/client');
const { createLogger } = require('./logger');
const { sendEmail } = require('../integrations/email');

const log = createLogger('monitoring');

// ---------------------------------------------------------------------------
// Platform Health
// ---------------------------------------------------------------------------

/**
 * Check health of all platform services:
 * Supabase, API, Worker, Telnyx, Buffer
 */
async function checkPlatformHealth() {
  const db = getServiceClient();
  const results = [];

  const checks = [
    { service: 'supabase', fn: () => checkSupabase(db) },
    { service: 'api', fn: () => checkApi() },
    { service: 'worker', fn: () => checkWorker(db) },
    { service: 'telnyx', fn: () => checkTelnyx() },
    { service: 'buffer', fn: () => checkBuffer() },
    // Lead-gen + AI dependencies. These fail SILENTLY inside agents (caught as
    // console.warn) so a credit-exhausted key looks like a healthy run. Probe
    // them here so an out-of-credits / revoked key is caught and alerted.
    { service: 'serper', fn: () => checkSerper() },
    { service: 'anthropic', fn: () => checkAnthropic() },
    { service: 'gemini', fn: () => checkGemini() },
  ];

  for (const check of checks) {
    const start = Date.now();
    let status = 'healthy';
    let errorMessage = null;

    try {
      await check.fn();
    } catch (err) {
      status = 'down';
      errorMessage = err.message;
      log.error(`${check.service} health check failed`, err);
    }

    const responseTime = Date.now() - start;

    // Slow responses count as degraded
    if (status === 'healthy' && responseTime > 5000) {
      status = 'degraded';
    }

    const result = {
      service: check.service,
      status,
      response_time_ms: responseTime,
      error_message: errorMessage,
    };

    results.push(result);

    // Persist (best-effort — a missing/locked table must NOT break alerting,
    // which is the whole point of this monitor). Supabase returns errors rather
    // than throwing, so check the returned error too.
    try {
      const { error: persistErr } = await db.from('platform_health_checks').insert(result);
      if (persistErr) log.warn(`Could not persist ${check.service} health check: ${persistErr.message}`);
    } catch (persistErr) {
      log.warn(`Could not persist ${check.service} health check`, persistErr);
    }
  }

  const downServices = results.filter(r => r.status === 'down');
  if (downServices.length > 0) {
    const names = downServices.map(s => s.service).join(', ');
    await sendCriticalAlert(`PLATFORM DOWN: Services failing — ${names}`);
  }

  log.info('Platform health check complete', {
    healthy: results.filter(r => r.status === 'healthy').length,
    degraded: results.filter(r => r.status === 'degraded').length,
    down: downServices.length,
  });

  return results;
}

async function checkSupabase(db) {
  const { error } = await db.from('tenants').select('id').limit(1);
  if (error) throw new Error(`Supabase query failed: ${error.message}`);
}

async function checkApi() {
  const apiUrl = process.env.API_URL || 'http://localhost:3000';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(`${apiUrl}/health`, { signal: controller.signal });
    if (!res.ok) throw new Error(`API returned ${res.status}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function checkWorker(db) {
  // Worker is healthy if it completed a job in the last 60 minutes. Some crons
  // only fire a few times a day, so a wider window avoids false alarms.
  const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { data, error } = await db
    .from('agent_jobs')
    .select('id')
    .gte('completed_at', cutoff)
    .limit(1);

  if (error) throw new Error(`Worker check query failed: ${error.message}`);
  // If no recently-completed jobs, check whether pending jobs are piling up
  // (queue moving = healthy; queue stuck with old pending work = down).
  if (!data || data.length === 0) {
    const stuckCutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const { data: pending } = await db
      .from('agent_jobs')
      .select('id')
      .eq('status', 'pending')
      .lte('scheduled_for', stuckCutoff)
      .limit(1);
    if (pending && pending.length > 0) {
      throw new Error('Worker appears stuck — jobs scheduled but none processed in 30+ min');
    }
    // No due jobs at all is fine
  }
}

async function checkTelnyx() {
  if (!process.env.TELNYX_API_KEY) {
    throw new Error('Telnyx API key not configured');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch('https://api.telnyx.com/v2/messaging_profiles?page[size]=1', {
      headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}` },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Telnyx returned ${res.status}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function checkBuffer() {
  // Buffer is NOT configured via BUFFER_ACCESS_TOKEN — the working publisher
  // reads the FGA corporate credentials via getFgaBufferConfig(): either the
  // FGA_BUFFER_API_KEY env override or the FGA tenant_integrations row
  // (service=buffer, credentials.api_key). It talks to the GraphQL API at
  // api.buffer.com/graphql, NOT the deprecated api.bufferapp.com REST endpoint.
  // This probe must use the same credential source and endpoint so it reflects
  // reality instead of flagging a non-existent env var.
  const { getFgaBufferConfig } = require('../integrations/buffer');
  const cfg = await getFgaBufferConfig();
  if (!cfg || !cfg.apiKey) {
    throw new Error('Buffer not configured (no FGA_BUFFER_API_KEY and no FGA tenant_integrations buffer row)');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    // `{ __typename }` is a valid query against any GraphQL schema, so it
    // verifies reachability + token auth without depending on Buffer's schema.
    // A bad/expired token returns 401; a healthy authed call returns 200.
    const res = await fetch('https://api.buffer.com/graphql', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: '{ __typename }' }),
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error('Buffer auth failed (token rejected — rotate FGA_BUFFER_API_KEY or the tenant_integrations buffer credential)');
    }
    if (!res.ok) throw new Error(`Buffer returned ${res.status}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function checkSerper() {
  // Serper powers prospecting + enrichment. When the account runs out of
  // credits it returns HTTP 400 {"message":"Not enough credits"} — the exact
  // failure that silently stalled lead-gen for ~2 weeks. A 1-result search is
  // the only reliable way to surface a credit-exhausted key.
  if (!process.env.SERPER_API_KEY) {
    throw new Error('SERPER_API_KEY not configured');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'X-API-KEY': process.env.SERPER_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ q: 'first gen automate health probe', num: 1 }),
      signal: controller.signal,
    });
    if (!res.ok) {
      let detail = '';
      try {
        const body = await res.json();
        detail = body && body.message ? `: ${body.message}` : '';
      } catch (_) { /* non-JSON body */ }
      if (res.status === 400 && /credit/i.test(detail)) {
        throw new Error(`Serper out of credits${detail}`);
      }
      if (res.status === 401 || res.status === 403) {
        throw new Error(`Serper auth failed (${res.status})${detail}`);
      }
      throw new Error(`Serper returned ${res.status}${detail}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function checkAnthropic() {
  // Claude powers outreach, enrichment, reply-classification, chat. A revoked
  // key or exhausted billing returns 401/402/429 — agents swallow this.
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ok' }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      let detail = '';
      try {
        const body = await res.json();
        detail = body?.error?.message ? `: ${body.error.message}` : '';
      } catch (_) { /* ignore */ }
      if (res.status === 401) throw new Error(`Anthropic auth failed (401)${detail}`);
      if (res.status === 402) throw new Error(`Anthropic billing/credits issue (402)${detail}`);
      throw new Error(`Anthropic returned ${res.status}${detail}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function checkGemini() {
  // Gemini (GOOGLE_API_KEY) powers content generation + Veo. Detect a
  // revoked/over-quota key.
  if (!process.env.GOOGLE_API_KEY) {
    throw new Error('GOOGLE_API_KEY not configured');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GOOGLE_API_KEY}`,
      { signal: controller.signal }
    );
    if (!res.ok) {
      let detail = '';
      try {
        const body = await res.json();
        detail = body?.error?.message ? `: ${body.error.message}` : '';
      } catch (_) { /* ignore */ }
      if (res.status === 400 || res.status === 403) {
        throw new Error(`Gemini key invalid/forbidden (${res.status})${detail}`);
      }
      if (res.status === 429) throw new Error(`Gemini quota exceeded (429)${detail}`);
      throw new Error(`Gemini returned ${res.status}${detail}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Tenant Health
// ---------------------------------------------------------------------------

/**
 * Run health check for a single tenant
 */
async function checkTenantHealth(tenantId) {
  const db = getServiceClient();
  const issues = [];
  const metrics = {};

  try {
    // Check automations ran recently (last 24h)
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: recentJobs, error: jobErr } = await db
      .from('job_queue')
      .select('id, status')
      .eq('tenant_id', tenantId)
      .gte('created_at', dayAgo);

    if (jobErr) {
      issues.push(`Job query failed: ${jobErr.message}`);
    } else {
      const total = recentJobs ? recentJobs.length : 0;
      const stuck = recentJobs ? recentJobs.filter(j => j.status === 'pending').length : 0;
      metrics.jobs_24h = total;
      metrics.stuck_jobs = stuck;
      if (stuck > 5) issues.push(`${stuck} stuck jobs in queue`);
    }

    // Check recent activity (leads, content, etc.)
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { count: leadCount } = await db
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .gte('created_at', weekAgo);

    metrics.leads_7d = leadCount || 0;

    const { count: contentCount } = await db
      .from('content')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .gte('created_at', weekAgo);

    metrics.content_7d = contentCount || 0;

    if ((leadCount || 0) === 0 && (contentCount || 0) === 0) {
      issues.push('No leads or content activity in 7 days');
    }
  } catch (err) {
    issues.push(`Health check error: ${err.message}`);
    log.error(`Tenant health check failed for ${tenantId}`, err);
  }

  const status = issues.length === 0 ? 'healthy' : issues.length <= 2 ? 'degraded' : 'down';

  const result = { tenant_id: tenantId, status, metrics, issues };

  await db.from('tenant_health_checks').insert(result);

  return result;
}

/**
 * Check health for all active tenants
 */
async function checkAllTenants() {
  const db = getServiceClient();
  const { data: tenants, error } = await db
    .from('tenants')
    .select('id, name, slug')
    .eq('status', 'active');

  if (error) {
    log.error('Failed to fetch tenants for health check', error);
    return [];
  }

  const results = [];
  for (const tenant of tenants || []) {
    const result = await checkTenantHealth(tenant.id);
    results.push({ ...result, name: tenant.name, slug: tenant.slug });
  }

  const degraded = results.filter(r => r.status !== 'healthy');
  if (degraded.length > 0) {
    log.warn(`${degraded.length}/${results.length} tenants have issues`, {
      degraded: degraded.map(r => r.slug || r.tenant_id),
    });
  }

  log.info('All-tenant health check complete', { total: results.length, issues: degraded.length });
  return results;
}

// ---------------------------------------------------------------------------
// System Status
// ---------------------------------------------------------------------------

/**
 * Aggregate system status for dashboard / digest
 */
async function getSystemStatus() {
  const db = getServiceClient();

  // Total active tenants
  const { count: totalTenants } = await db
    .from('tenants')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'active');

  // Latest tenant health checks (most recent per tenant)
  const { data: latestChecks } = await db
    .from('tenant_health_checks')
    .select('tenant_id, status, created_at')
    .order('created_at', { ascending: false })
    .limit(500);

  // Deduplicate to latest per tenant
  const seen = new Set();
  const uniqueChecks = [];
  for (const check of latestChecks || []) {
    if (!seen.has(check.tenant_id)) {
      seen.add(check.tenant_id);
      uniqueChecks.push(check);
    }
  }

  const healthy = uniqueChecks.filter(c => c.status === 'healthy').length;
  const degraded = uniqueChecks.filter(c => c.status === 'degraded').length;
  const down = uniqueChecks.filter(c => c.status === 'down').length;

  // Latest platform check
  const { data: lastPlatform } = await db
    .from('platform_health_checks')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(1);

  return {
    total_tenants: totalTenants || 0,
    healthy,
    degraded,
    down,
    last_check: lastPlatform?.[0]?.created_at || null,
    platform_status: lastPlatform?.[0]?.status || 'unknown',
  };
}

// ---------------------------------------------------------------------------
// Critical Alerts
// ---------------------------------------------------------------------------

/**
 * Send a critical alert to the founder
 * Only for: system down, payment failure after 3 retries
 */
async function sendCriticalAlert(message) {
  const founderEmail = process.env.FOUNDER_EMAIL || 'patrick@firstgenautomate.com';

  log.error(`CRITICAL ALERT: ${message}`);

  try {
    await sendEmail(
          founderEmail,
      `[CRITICAL] First Gen Automate Platform Alert`,
      `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;">
        <div style="background:#DC2626;color:white;padding:16px 24px;border-radius:8px 8px 0 0;">
          <h2 style="margin:0;font-size:18px;">Critical Alert</h2>
        </div>
        <div style="border:1px solid #E5E7EB;border-top:none;padding:24px;border-radius:0 0 8px 8px;">
          <p style="font-size:16px;color:#132A4A;margin:0 0 16px 0;">${message}</p>
          <p style="font-size:14px;color:#6B7280;margin:0;">
            Time: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })}
          </p>
        </div>
      </div>`,
      { tenantSlug: 'platform' }
    );
  } catch (err) {
    log.error('Failed to send critical alert email', err);
  }
}

module.exports = {
  checkPlatformHealth,
  checkTenantHealth,
  checkAllTenants,
  getSystemStatus,
  sendCriticalAlert,
};
