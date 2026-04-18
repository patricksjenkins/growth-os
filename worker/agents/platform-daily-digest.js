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
 */
function renderTenantRows(tenants, jobs, leads, content, messages) {
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

  // Sort tenants: those with failures first, then those with most activity,
  // then alphabetical. Quick way to surface "problem children" now without
  // us having to scan the email later.
  const scored = tenants.map((t) => {
    const tjobs = jobsByTenant.get(t.id) || [];
    const failed = tjobs.filter((j) => j.status === 'failed').length;
    const activity = (leadsByTenant.get(t.id) || []).length
      + (contentByTenant.get(t.id) || []).length
      + (messagesByTenant.get(t.id) || []).length;
    return { t, tjobs, failed, activity };
  });
  scored.sort((a, b) => (b.failed - a.failed) || (b.activity - a.activity) || a.t.name.localeCompare(b.t.name));

  return scored.map(({ t, tjobs, failed, activity }) => {
    const newLeads = (leadsByTenant.get(t.id) || []).length;
    const postsPublished = (contentByTenant.get(t.id) || []).filter((c) => c.status === 'posted').length;
    const smsSent = (messagesByTenant.get(t.id) || []).filter(
      (m) => m.channel === 'sms' && m.direction === 'outbound'
    ).length;

    // Per-tenant health dot — red if any failures, yellow if zero activity
    // AND zero jobs (agent didn't even run for them), green otherwise.
    let dotColor = '#22C55E'; // green
    if (failed > 0) dotColor = '#EF4444';
    else if (tjobs.length === 0 && activity === 0) dotColor = '#F59E0B';

    return `
      <tr style="border-top:1px solid #E5E7EB;">
        <td style="padding:10px 12px;font-size:13px;color:#111827;font-weight:600;">${escapeHtml(t.name)}</td>
        <td style="padding:10px 12px;font-size:13px;color:#111827;text-align:right;">${newLeads}</td>
        <td style="padding:10px 12px;font-size:13px;color:#111827;text-align:right;">${postsPublished}</td>
        <td style="padding:10px 12px;font-size:13px;color:#111827;text-align:right;">${smsSent}</td>
        <td style="padding:10px 12px;font-size:13px;color:${failed > 0 ? '#B91C1C' : '#111827'};text-align:right;font-weight:${failed > 0 ? 700 : 400};">${failed}</td>
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

  // Platform-level guard. Accepts the conventional slug/tier/is_platform
  // flags OR the 'fga' slug, which IS the platform tenant in this deployment
  // (see FGA_TENANT_ID hardcoded in api/routes/admin.js).
  const isPlatform =
    tenant.slug === 'platform' ||
    tenant.slug === 'fga' ||
    tenant.tier === 'platform' ||
    tenant.is_platform === true;
  if (!isPlatform) {
    log.warn('Blocked non-platform tenant', { slug: tenant.slug });
    return { success: false, error: 'platform-daily-digest is a platform-level agent' };
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
  const [tenantsRes, jobsPage, activityPage, leadsRes, contentRes, messagesRes] = await Promise.all([
    supabase.from('tenants').select('id,name,slug,status').eq('status', 'active'),
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
  const jobs = jobsPage.rows;
  const activity = activityPage.rows;
  const leads = leadsRes.data || [];
  const content = contentRes.data || [];
  const messages = messagesRes.data || [];

  // With pagination the fetched count now equals the true count up to our
  // 50-page safety cap (50k rows). Kept the truncated flag as belt-and-suspenders
  // in case volume ever exceeds the cap.
  const jobsTotalExact = jobsPage.count;
  const truncated = jobs.length < jobsTotalExact;

  log.info('Fetched 24h rollup', {
    tenants: tenants.length,
    jobs_fetched: jobs.length,
    jobs_total_exact: jobsTotalExact,
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

  // --- Render ---
  // When the agent_jobs query was truncated, we show the scaled failure
  // count alongside a footnote so the numbers add up but the reader knows
  // it's a statistical sample.
  const jobsSucceededScaled = truncated
    ? Math.max(0, jobsTotalExact - jobsFailedScaled)
    : jobsSucceeded;
  const vars = {
    date,
    health_badge: health.badge,
    health_bg: health.bg,
    health_color: health.color,
    jobs_total: String(jobsTotalExact),
    jobs_succeeded: String(jobsSucceededScaled),
    jobs_failed: String(jobsFailedScaled) + (truncated ? ` (est.)` : ''),
    failure_rate_pct: String(failureRatePct),
    new_leads: String(newLeads),
    posts_published: String(postsPublished),
    sms_sent: String(smsSent),
    reviews_requested: String(reviewsRequested),
    active_tenants: String(tenants.length),
    tenant_rows: renderTenantRows(tenants, jobs, leads, content, messages),
    failing_agents_section: renderFailingAgentsSection(jobs),
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
      health_level: health.level,
    },
    error: emailResult?.error || null,
  });

  return {
    success: !emailResult?.error,
    tenants_covered: tenants.length,
    jobs_total: jobsTotalExact,
    jobs_failed: jobsFailedScaled,
    health_level: health.level,
    truncated_sample: truncated,
    new_leads: newLeads,
    posts_published: postsPublished,
    sms_sent: smsSent,
    reviews_requested: reviewsRequested,
    email_result: emailResult,
  };
}

module.exports = run;
