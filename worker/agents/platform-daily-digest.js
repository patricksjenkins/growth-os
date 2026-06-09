/**
 * Growth OS — Platform Daily Digest Agent
 *
 * Cross-tenant report emailed to the platform owner (Patrick) every morning
 * at 7am. Answers the question "did the 32 scheduled agents actually run
 * yesterday, and what did they produce across all my tenants?"
 *
 * Not to be confused with `digest` (per-tenant end-of-day) or `chief-of-staff`
 * (per-tenant briefing). Those are for individual business owners seeing
 * their own business. THIS agent is platform-wide and only runs for the
 * platform tenant (guard identical to account-management.js / client-health.js).
 *
 * Reads from existing tables — no schema changes:
 *   - agent_jobs:          per-agent run status in last 24h (health)
 *   - agent_activity_log:  per-agent action log in last 24h
 *   - leads:               new leads captured in last 24h
 *   - content_drafts:      posts published / drafted in last 24h
 *   - messages:            SMS sent in last 24h
 *
 * Sections of the email:
 *   1. HEALTH BANNER — green/yellow/red based on job failure rate
 *   2. ACTIVITY  — 4 numeric stats (Leads / Posts / SMS / Reviews)
 *   3. PER-TENANT TABLE — one row per active tenant (small tenant count
 *      today; we'll switch to "only problem tenants" once there are 10+).
 *   4. FAILING AGENTS (conditional) — only renders if any jobs failed.
 */

const { createLogger } = require('../../core/logger');
const { getServiceClient } = require('../../db/client');
const email = require('../../integrations/email');

const PLATFORM_OWNER_EMAIL =
  process.env.PLATFORM_OWNER_EMAIL || 'patrick@firstgenautomate.com';

// V1 hardening (2026-05-24): centralized constant. The FGA tenant IS the
// platform tenant in this deployment.
const { FGA_TENANT_ID } = require('../../core/config');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(d = new Date()) {
  return d.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Fetch all rows from a Supabase query that may return more than the hosted
 * 1000-row cap. Paginates by offset using .range(). Uses count='exact' so we
 * can track progress without making an extra HEAD call.
 *
 * @param {() => import('@supabase/postgrest-js').PostgrestBuilder} queryBuilder
 *   A zero-arg function that returns a fresh query each time it's called (a
 *   query can't be cloned; we rebuild it for each page).
 * @param {number} pageSize  rows per request (<=1000)
 * @returns {Promise<{ rows: any[], count: number }>}
 */
async function fetchAllPaginated(queryBuilder, pageSize = 1000) {
  const rows = [];
  let offset = 0;
  let totalCount = 0;
  let fetched = 0;
  // Safety cap at 50k rows / 50 pages — realistically we'll hit a daily
  // job volume ceiling long before this.
  for (let page = 0; page < 50; page++) {
    const res = await queryBuilder()
      .range(offset, offset + pageSize - 1);
    if (res.error) throw res.error;
    const batch = res.data || [];
    if (res.count != null) totalCount = res.count;
    rows.push(...batch);
    fetched += batch.length;
    if (batch.length < pageSize) break;  // last page
    if (fetched >= totalCount && totalCount > 0) break;
    offset += pageSize;
  }
  return { rows, count: totalCount || rows.length };
}

/**
 * Classify the platform into GREEN / YELLOW / RED based on job failure rate
 * over the last 24h. Returns CSS-ready color triple for the email banner.
 *
 * If jobs were truncated by Supabase's row ceiling we accept an exact count
 * from outside and scale the failed count proportionally (the sample is
 * ordered by created_at, uncorrelated with failure, so the ratio is unbiased).
 */
function computeHealthBadge(jobs, exactTotal) {
  const sampleTotal = jobs.length;
  const total = exactTotal != null ? exactTotal : sampleTotal;
  const sampleFailed = jobs.filter((j) => j.status === 'failed').length;
  const failed = sampleTotal > 0 && exactTotal != null && exactTotal !== sampleTotal
    ? Math.round(sampleFailed * (exactTotal / sampleTotal))
    : sampleFailed;

  if (total === 0) {
    // Scheduler probably stopped — this is the canary
    return {
      badge: 'SCHEDULER QUIET — 0 jobs ran in the last 24h',
      bg: '#FEE2E2',     // red-100
      color: '#B91C1C',  // red-700
      level: 'red',
    };
  }

  const rate = failed / total;
  if (rate >= 0.20) {
    return {
      badge: `RED — ${failed}/${total} jobs failed (${Math.round(rate * 100)}%)`,
      bg: '#FEE2E2',
      color: '#B91C1C',
      level: 'red',
    };
  }
  if (rate >= 0.05) {
    return {
      badge: `YELLOW — ${failed}/${total} jobs failed (${Math.round(rate * 100)}%)`,
      bg: '#FEF3C7',     // amber-100
      color: '#B45309',  // amber-700
      level: 'yellow',
    };
  }
  return {
    badge: `GREEN — ${total} jobs ran, ${failed} failed`,
    bg: '#DCFCE7',     // green-100
    color: '#166534',  // green-800
    level: 'green',
  };
}

/**
 * Merge crash-rate health with dependency health and business-output health.
 *
 * computeHealthBadge() only knows whether jobs THREW — it returns GREEN when
 * "133 jobs succeeded" even though a swallowed out-of-credits Serper key
 * produced ZERO leads. That's exactly how a 2-week lead-gen stall stayed
 * invisible. This merges in two signals the crash rate is blind to:
 *
 *   1. DEPENDENCY DOWN — latest system-monitor probe shows a dependency
 *      (Serper / Anthropic / Gemini / Telnyx / Buffer / worker) is down.
 *      Any down dependency forces RED.
 *   2. OUTPUT COLLAPSE — today produced 0 of an output the platform normally
 *      produces (trailing 7-day daily average >= 1). Downgrades to YELLOW.
 *
 * Final level = worst of crash / dependency / output. The banner keeps the
 * crash summary and appends the new reasons so nothing is hidden.
 */
function computeFinalHealth(crashHealth, deps, outcomes, baseline) {
  const order = { green: 0, yellow: 1, red: 2 };
  const worse = (a, b) => (order[a] >= order[b] ? a : b);

  let level = crashHealth.level;
  const reasons = [];

  const downDeps = (deps || []).filter((d) => d.status === 'down');
  if (downDeps.length) {
    level = worse(level, 'red');
    reasons.push(`DEPENDENCY DOWN: ${downDeps.map((d) => d.service).join(', ')}`);
  }

  const collapses = [];
  const checkCollapse = (label, today, perDay) => {
    if (perDay >= 1 && today === 0) {
      collapses.push(`${label} 0 today (≈${perDay.toFixed(1)}/day normally)`);
    }
  };
  checkCollapse('leads', outcomes.newLeads, baseline.leadsPerDay);
  checkCollapse('posts', outcomes.postsPublished, baseline.postsPerDay);
  checkCollapse('SMS', outcomes.smsSent, baseline.smsPerDay);
  if (collapses.length) {
    level = worse(level, 'yellow');
    reasons.push(`OUTPUT COLLAPSE: ${collapses.join('; ')}`);
  }

  if (!reasons.length) return crashHealth; // crash badge already says it all

  const palette = {
    red: { bg: '#FEE2E2', color: '#B91C1C' },
    yellow: { bg: '#FEF3C7', color: '#B45309' },
    green: { bg: '#DCFCE7', color: '#166534' },
  };
  const p = palette[level];
  return {
    badge: `${level.toUpperCase()} — ${reasons.join(' · ')} | ${crashHealth.badge}`,
    bg: p.bg,
    color: p.color,
    level,
  };
}

/**
 * Latest health-probe status per dependency, written by the system-monitor
 * agent into platform_health_checks. Returns [] if the table is empty or the
 * monitor hasn't run yet (best-effort — never breaks the digest).
 */
async function fetchLatestDependencyHealth(supabase) {
  try {
    const { data, error } = await supabase
      .from('platform_health_checks')
      .select('service,status,error_message,created_at')
      .order('created_at', { ascending: false })
      .limit(200);
    if (error || !data) return [];
    const seen = new Set();
    const latest = [];
    for (const row of data) {
      if (seen.has(row.service)) continue;
      seen.add(row.service);
      latest.push(row);
    }
    return latest;
  } catch (_) {
    return [];
  }
}

/**
 * Trailing 7-day daily-average output (leads / posts / outbound SMS) so the
 * digest can tell "0 leads today" (normal for a quiet platform) apart from
 * "0 leads today but we usually do 12" (a collapse worth flagging). Excludes
 * demo tenants. Best-effort — returns zeros on any error.
 */
async function fetchOutcomeBaseline(supabase, demoTenantIds) {
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const demoIds = [...demoTenantIds];
  const excludeDemo = (q) =>
    demoIds.length ? q.not('tenant_id', 'in', `(${demoIds.join(',')})`) : q;
  try {
    const [leadsRes, contentRes, smsRes] = await Promise.all([
      excludeDemo(
        supabase.from('leads').select('id', { count: 'exact', head: true }).gte('created_at', since7d)
      ),
      excludeDemo(
        supabase
          .from('content_drafts')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'posted')
          .gte('posted_at', since7d)
      ),
      excludeDemo(
        supabase
          .from('messages')
          .select('id', { count: 'exact', head: true })
          .eq('channel', 'sms')
          .eq('direction', 'outbound')
          .gte('created_at', since7d)
      ),
    ]);
    return {
      leadsPerDay: (leadsRes.count || 0) / 7,
      postsPerDay: (contentRes.count || 0) / 7,
      smsPerDay: (smsRes.count || 0) / 7,
    };
  } catch (_) {
    return { leadsPerDay: 0, postsPerDay: 0, smsPerDay: 0 };
  }
}

/**
 * Compute the top N failing agents for the "Failing Agents" section.
 * Returns HTML string (empty if nothing failed).
 */
function renderFailingAgentsSection(jobs) {
  const failed = jobs.filter((j) => j.status === 'failed');
  if (!failed.length) return '';

  // Group by agent_name, count + sample error
  const byAgent = new Map();
  for (const j of failed) {
    if (!byAgent.has(j.agent_name)) {
      byAgent.set(j.agent_name, { count: 0, sample_error: j.error || null });
    }
    byAgent.get(j.agent_name).count += 1;
  }

  const rows = [...byAgent.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 5)
    .map(([agentName, { count, sample_error }]) => `
      <tr>
        <td style="padding:8px 12px;font-size:13px;color:#111827;font-weight:600;">${escapeHtml(agentName)}</td>
        <td style="padding:8px 12px;font-size:13px;color:#B91C1C;font-weight:700;text-align:right;">${count}</td>
        <td style="padding:8px 12px;font-size:12px;color:#6B7280;">${escapeHtml((sample_error || '').slice(0, 80))}</td>
      </tr>`)
    .join('');

  return `
    <tr><td style="padding:24px 32px 0;">
      <h2 style="margin:0 0 12px;color:#132A4A;font-size:16px;font-weight:700;border-bottom:2px solid #EF4444;padding-bottom:8px;">
        Failing Agents
      </h2>
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        <tr style="background:#F9FAFB;">
          <td style="padding:8px 12px;font-size:12px;color:#6B7280;font-weight:600;">Agent</td>
          <td style="padding:8px 12px;font-size:12px;color:#6B7280;font-weight:600;text-align:right;">Failures</td>
          <td style="padding:8px 12px;font-size:12px;color:#6B7280;font-weight:600;">Sample error</td>
        </tr>
        ${rows}
      </table>
    </td></tr>`;
}

/**
 * Per-tenant table rows. Given tenants + all job/lead/content/message rows
 * for the last 24h, emit one <tr> per active tenant with counts.
 *
 * Demo tenants are labeled "(demo)" and their failures do NOT drive the
 * red health dot — demo agents fail safely by design. They're shown at
 * the bottom with gray text so they don't visually compete with real
 * tenants' numbers.
 */
function renderTenantRows(tenants, jobs, leads, content, messages, demoTenantIds = new Set()) {
  if (!tenants.length) {
    return `
      <tr>
        <td colspan="6" style="padding:16px;text-align:center;font-size:13px;color:#9CA3AF;">
          No active tenants
        </td>
      </tr>`;
  }

  // Bucket by tenant_id for O(N) lookups
  const by = (rows) => {
    const m = new Map();
    for (const r of rows || []) {
      const arr = m.get(r.tenant_id) || [];
      arr.push(r);
      m.set(r.tenant_id, arr);
    }
    return m;
  };
  const jobsByTenant = by(jobs);
  const leadsByTenant = by(leads);
  const contentByTenant = by(content);
  const messagesByTenant = by(messages);

  // Sort: real tenants first (failures desc, then activity desc), demo
  // tenants at the bottom.
  const scored = tenants.map((t) => {
    const tjobs = jobsByTenant.get(t.id) || [];
    const failed = tjobs.filter((j) => j.status === 'failed').length;
    const activity = (leadsByTenant.get(t.id) || []).length
      + (contentByTenant.get(t.id) || []).length
      + (messagesByTenant.get(t.id) || []).length;
    const isDemo = demoTenantIds.has(t.id);
    return { t, tjobs, failed, activity, isDemo };
  });
  scored.sort((a, b) => {
    if (a.isDemo !== b.isDemo) return a.isDemo ? 1 : -1; // demo at bottom
    return (b.failed - a.failed) || (b.activity - a.activity) || a.t.name.localeCompare(b.t.name);
  });

  return scored.map(({ t, tjobs, failed, activity, isDemo }) => {
    const newLeads = (leadsByTenant.get(t.id) || []).length;
    const postsPublished = (contentByTenant.get(t.id) || []).filter((c) => c.status === 'posted').length;
    const smsSent = (messagesByTenant.get(t.id) || []).filter(
      (m) => m.channel === 'sms' && m.direction === 'outbound'
    ).length;

    // Per-tenant health dot:
    //   demo tenants -> gray (not real, just showing activity)
    //   real + failures -> red
    //   real + zero activity AND zero jobs -> yellow (scheduler missed them)
    //   real + healthy -> green
    let dotColor;
    if (isDemo) {
      dotColor = '#9CA3AF'; // gray
    } else if (failed > 0) {
      dotColor = '#EF4444';
    } else if (tjobs.length === 0 && activity === 0) {
      dotColor = '#F59E0B';
    } else {
      dotColor = '#22C55E';
    }

    // Demo rows are gray-muted so they don't steal the eye from real numbers.
    const rowText = isDemo ? '#6B7280' : '#111827';
    const failedText = isDemo
      ? '#9CA3AF'
      : (failed > 0 ? '#B91C1C' : '#111827');
    const failedWeight = (!isDemo && failed > 0) ? 700 : 400;
    const nameCell = isDemo
      ? `${escapeHtml(t.name)} <span style="color:#9CA3AF;font-weight:400;font-size:11px;">(demo)</span>`
      : escapeHtml(t.name);

    return `
      <tr style="border-top:1px solid #E5E7EB;">
        <td style="padding:10px 12px;font-size:13px;color:${rowText};font-weight:600;">${nameCell}</td>
        <td style="padding:10px 12px;font-size:13px;color:${rowText};text-align:right;">${newLeads}</td>
        <td style="padding:10px 12px;font-size:13px;color:${rowText};text-align:right;">${postsPublished}</td>
        <td style="padding:10px 12px;font-size:13px;color:${rowText};text-align:right;">${smsSent}</td>
        <td style="padding:10px 12px;font-size:13px;color:${failedText};text-align:right;font-weight:${failedWeight};">${failed}</td>
        <td style="padding:10px 12px;text-align:center;">
          <span style="display:inline-block;width:10px;height:10px;border-radius:5px;background:${dotColor};"></span>
        </td>
      </tr>`;
  }).join('');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * @param {Object} tenant - Resolved tenant (must be the platform tenant)
 * @param {Object} payload - unused
 */
async function run(tenant, _payload = {}) {
  const log = createLogger('platform-daily-digest', tenant.slug);

  // Platform-level guard. Accept ANY of:
  //  - tenant.id === FGA_TENANT_ID  (authoritative — most reliable)
  //  - tenant.slug in ('platform','fga')
  //  - tenant.tier === 'platform' or tenant.is_platform === true
  // The earlier version matched only on slug/tier/is_platform, so if FGA's
  // tenant row had a different slug ('first-gen-automate', say) the digest
  // silently skipped. ID-based check eliminates that class of failure.
  const isPlatform =
    tenant.id === FGA_TENANT_ID ||
    tenant.slug === 'platform' ||
    tenant.slug === 'fga' ||
    tenant.tier === 'platform' ||
    tenant.is_platform === true;
  if (!isPlatform) {
    log.info('Non-platform tenant — skipping digest (expected for most tenants)', { slug: tenant.slug, id: tenant.id });
    return { success: true, skipped: true, reason: 'not platform tenant' };
  }

  const supabase = getServiceClient();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const date = formatDate();

  // Parallel cross-tenant fetch. content_drafts is OR'd on created_at OR
  // posted_at because a post drafted 48h ago and posted today should still
  // count toward "Posts published today".
  //
  // agent_jobs and agent_activity_log can easily exceed Supabase's 1000-row
  // default cap (speed-to-lead alone = 720 jobs/day/tenant). We paginate
  // those two. The lower-volume tables use a single request.
  //
  // We pull is_demo on the tenants query so we can exclude demo-tenant jobs
  // from the top-line aggregates — demo agents fail safely by design (the
  // demo-guard short-circuits real sends) and their activity is seeded data,
  // not real operations. Demo tenants still appear in the per-tenant table
  // for visibility, just labeled "(demo)".
  const [tenantsRes, jobsPage, activityPage, leadsRes, contentRes, messagesRes] = await Promise.all([
    supabase.from('tenants').select('id,name,slug,status,is_demo').eq('status', 'active'),
    fetchAllPaginated(() =>
      supabase
        .from('agent_jobs')
        .select('tenant_id,agent_name,status,error,created_at', { count: 'exact' })
        .gte('created_at', since)
        .order('created_at', { ascending: false })
    ),
    fetchAllPaginated(() =>
      supabase
        .from('agent_activity_log')
        .select('tenant_id,agent_name,action,status,records_affected', { count: 'exact' })
        .gte('created_at', since)
        .order('created_at', { ascending: false })
    ),
    supabase.from('leads').select('tenant_id,id,status').gte('created_at', since),
    supabase.from('content_drafts')
      .select('tenant_id,id,status,platform,posted_at,created_at')
      .or(`created_at.gte.${since},posted_at.gte.${since}`),
    supabase.from('messages').select('tenant_id,id,channel,direction').gte('sent_at', since),
  ]);

  const tenants = tenantsRes.data || [];
  const demoTenantIds = new Set(tenants.filter((t) => t.is_demo).map((t) => t.id));
  const realTenants = tenants.filter((t) => !t.is_demo);

  // Split every fetched dataset into real vs demo. Top-line aggregates use
  // `real` rows only; per-tenant table uses the full set (so the demo row
  // still shows but its numbers don't pollute platform health).
  const notDemo = (row) => !demoTenantIds.has(row.tenant_id);
  const allJobs = jobsPage.rows;
  const jobs = allJobs.filter(notDemo);
  const activity = (activityPage.rows || []).filter(notDemo);
  const leads = (leadsRes.data || []).filter(notDemo);
  const content = (contentRes.data || []).filter(notDemo);
  const messages = (messagesRes.data || []).filter(notDemo);

  // Keep the unfiltered rows for the per-tenant table rendering
  const allLeads = leadsRes.data || [];
  const allContent = contentRes.data || [];
  const allMessages = messagesRes.data || [];

  // Exact count adjustment — the Supabase .count returned the unfiltered
  // total, so subtract demo-tenant jobs from it.
  const demoJobsInSample = allJobs.length - jobs.length;
  const demoRatioInSample = allJobs.length > 0 ? demoJobsInSample / allJobs.length : 0;
  const jobsTotalExact = Math.round(jobsPage.count * (1 - demoRatioInSample));
  const truncated = jobs.length < jobsTotalExact;

  log.info('Fetched 24h rollup (real tenants only)', {
    tenants_total: tenants.length,
    tenants_real: realTenants.length,
    tenants_demo: demoTenantIds.size,
    jobs_fetched_real: jobs.length,
    jobs_total_exact_real: jobsTotalExact,
    jobs_all_fetched: allJobs.length,
    truncated,
    activity: activity.length,
    leads: leads.length,
    content: content.length,
    messages: messages.length,
  });

  // --- Compute aggregates ---
  const health = computeHealthBadge(jobs, jobsTotalExact);
  const jobsFailed = jobs.filter((j) => j.status === 'failed').length;
  const jobsSucceeded = jobs.filter((j) => j.status === 'completed').length;
  // When truncated, scale the failed count proportionally for an accurate
  // headline rate. This is a statistical approximation but it's unbiased
  // because the 5000-row sample is ordered by created_at — not correlated
  // with success/failure — so the sampled failure rate ≈ true failure rate.
  const jobsFailedScaled = truncated
    ? Math.round(jobsFailed * (jobsTotalExact / jobs.length))
    : jobsFailed;
  const failureRatePct = jobsTotalExact > 0
    ? Math.round((jobsFailedScaled / jobsTotalExact) * 100)
    : 0;

  const newLeads = leads.length;
  const postsPublished = content.filter((c) => c.status === 'posted').length;
  const smsSent = messages.filter((m) => m.channel === 'sms' && m.direction === 'outbound').length;
  const reviewsRequested = activity.filter(
    (a) => a.agent_name === 'review-request' && a.status === 'success'
  ).length;

  // Outcome-aware health: crash-rate alone returns GREEN when jobs "succeed"
  // but swallowed a dead dependency and produced nothing. Pull the latest
  // dependency probes (system-monitor) + a 7-day output baseline and merge.
  const [deps, baseline] = await Promise.all([
    fetchLatestDependencyHealth(supabase),
    fetchOutcomeBaseline(supabase, demoTenantIds),
  ]);
  const finalHealth = computeFinalHealth(
    health,
    deps,
    { newLeads, postsPublished, smsSent },
    baseline,
  );
  const downDeps = deps.filter((d) => d.status === 'down');

  // --- Render ---
  // When the agent_jobs query was truncated, we show the scaled failure
  // count alongside a footnote so the numbers add up but the reader knows
  // it's a statistical sample.
  const jobsSucceededScaled = truncated
    ? Math.max(0, jobsTotalExact - jobsFailedScaled)
    : jobsSucceeded;
  const vars = {
    date,
    health_badge: finalHealth.badge,
    health_bg: finalHealth.bg,
    health_color: finalHealth.color,
    jobs_total: String(jobsTotalExact),
    jobs_succeeded: String(jobsSucceededScaled),
    jobs_failed: String(jobsFailedScaled) + (truncated ? ` (est.)` : ''),
    failure_rate_pct: String(failureRatePct),
    new_leads: String(newLeads),
    posts_published: String(postsPublished),
    sms_sent: String(smsSent),
    reviews_requested: String(reviewsRequested),
    active_tenants: String(realTenants.length),
    tenant_rows: renderTenantRows(tenants, allJobs, allLeads, allContent, allMessages, demoTenantIds),
    failing_agents_section: renderFailingAgentsSection(jobs),   // real failures only
  };

  let emailResult = null;
  try {
    emailResult = await email.sendTemplateEmail(
      PLATFORM_OWNER_EMAIL,
      'platform-daily-digest',
      vars,
      { subject: `FGA Daily — ${date}` },
    );
    log.success(`Daily digest sent to ${PLATFORM_OWNER_EMAIL}`, {
      jobs: jobs.length, failed: jobsFailed, tenants: tenants.length,
    });
  } catch (err) {
    log.error(`Failed to send daily digest: ${err.message}`);
    // Don't throw — we still want to log the activity row below so we can
    // see from Supabase that the agent ran even if Resend was down.
    emailResult = { error: err.message };
  }

  // Record that we fired. Useful for the NEXT day's digest to show in the
  // per-tenant table that the platform tenant itself had activity.
  await supabase.from('agent_activity_log').insert({
    tenant_id: tenant.id,
    agent_name: 'platform-daily-digest',
    action: 'digest_sent',
    status: emailResult?.error ? 'failed' : 'success',
    details: {
      tenants_covered: tenants.length,
      jobs_total: jobs.length,
      jobs_failed: jobsFailed,
      health_level: finalHealth.level,
      crash_health_level: health.level,
      down_dependencies: downDeps.map((d) => d.service),
    },
    error: emailResult?.error || null,
  });

  return {
    success: !emailResult?.error,
    tenants_covered: tenants.length,
    jobs_total: jobsTotalExact,
    jobs_failed: jobsFailedScaled,
    health_level: finalHealth.level,
    crash_health_level: health.level,
    down_dependencies: downDeps.map((d) => d.service),
    truncated_sample: truncated,
    new_leads: newLeads,
    posts_published: postsPublished,
    sms_sent: smsSent,
    reviews_requested: reviewsRequested,
    email_result: emailResult,
  };
}

module.exports = run;
