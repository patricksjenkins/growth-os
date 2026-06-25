/**
 * First Gen Automate — Agent Hub (admin-only routes)
 *
 * Mounted at /api/admin/agent-hub behind authMiddleware + adminMiddleware, so
 * only FGA platform-owner users can reach it. NOT a customer feature.
 *
 * Answers the question the daily digest couldn't: "are my agents actually
 * WORKING, or just not crashing?" Surfaces three things in one place:
 *   1. DEPENDENCIES — live status of every external service (Serper, Anthropic,
 *      Gemini, Telnyx, Buffer) + platform services, with the agents each one
 *      powers. A down dependency is shown as ONE root cause, not N mystery
 *      agent failures.
 *   2. AGENTS — per-agent run health from agent_jobs (last 24h + 7d): last run,
 *      last status, failure counts, sample error.
 *   3. OUTPUT — what the platform actually produced (leads / posts / SMS) over
 *      24h vs a 7-day daily baseline, so silent output collapse is visible.
 *
 * GET  /            full snapshot (persisted dependency probes + agent rollup)
 * POST /probe       run a live checkPlatformHealth() sweep now and return it
 */

const express = require('express');
const router = express.Router();

const { getServiceClient } = require('../../db/client');
const { createLogger } = require('../../core/logger');
const { checkPlatformHealth } = require('../../core/monitoring');

const log = createLogger('admin-agent-hub');

// Which agents each dependency powers. Lets the UI say "Serper down →
// prospecting + enrichment affected" instead of leaving the operator to guess.
const DEPENDENCY_AGENTS = {
  serper: ['prospecting', 'enrichment', 'facebook-prospecting', 'targeted-campaign'],
  anthropic: ['outreach', 'enrichment', 'reply-classification', 'conversation-responder', 'content-generation', 'chief-of-staff', 'drip-campaign', 'targeted-campaign'],
  gemini: ['content-generation', 'image-generation', 'advertising'],
  telnyx: ['speed-to-lead', 'follow-up', 'missed-call', 'review-request', 'referral-request', 'inbound-sms-responder', 'facebook-prospecting'],
  buffer: ['publisher', 'distribution', 'campaign-orchestrator'],
  supabase: ['*'],
  api: ['*'],
  worker: ['*'],
};

// Human-readable label + what a healthy probe means.
const DEPENDENCY_LABELS = {
  serper: { label: 'Serper (Google Search)', role: 'Powers prospecting + lead enrichment' },
  anthropic: { label: 'Anthropic (Claude)', role: 'Powers outreach, enrichment, replies, content' },
  gemini: { label: 'Google Gemini', role: 'Powers content + image generation' },
  telnyx: { label: 'Telnyx (SMS)', role: 'Sends all outbound texts' },
  buffer: { label: 'Buffer', role: 'Publishes social posts' },
  supabase: { label: 'Supabase (Database)', role: 'Primary data store' },
  api: { label: 'API server', role: 'Serves the app + portals' },
  worker: { label: 'Worker (job queue)', role: 'Runs every scheduled agent' },
};

/** Latest persisted probe per dependency from platform_health_checks. */
async function fetchLatestDependencyHealth(db) {
  const { data, error } = await db
    .from('platform_health_checks')
    .select('service,status,response_time_ms,error_message,created_at')
    .order('created_at', { ascending: false })
    .limit(300);
  if (error || !data) return [];
  const seen = new Set();
  const latest = [];
  for (const row of data) {
    if (seen.has(row.service)) continue;
    seen.add(row.service);
    latest.push(row);
  }
  return latest;
}

/** Shape a probe row into the dependency card the UI renders. */
function toDependencyCard(probe) {
  const meta = DEPENDENCY_LABELS[probe.service] || { label: probe.service, role: '' };
  return {
    service: probe.service,
    label: meta.label,
    role: meta.role,
    status: probe.status,
    response_time_ms: probe.response_time_ms ?? null,
    error_message: probe.error_message || null,
    checked_at: probe.created_at || null,
    powers_agents: DEPENDENCY_AGENTS[probe.service] || [],
  };
}

/**
 * Per-agent run health from agent_jobs over the trailing 7 days. Returns a map
 * keyed by agent_name. Excludes demo tenants so a demo agent's by-design
 * no-op doesn't read as a failure.
 */
async function fetchAgentRollup(db, demoTenantIds) {
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // Bounded pull. last 7d of jobs ordered newest-first; we only need the
  // status/error/timestamps to build per-agent health.
  const { data, error } = await db
    .from('agent_jobs')
    .select('tenant_id,agent_name,status,error,created_at,completed_at')
    .gte('created_at', since7d)
    .order('created_at', { ascending: false })
    .limit(8000);
  if (error || !data) return [];

  const isDemo = (id) => demoTenantIds.has(id);
  const byAgent = new Map();
  for (const j of data) {
    if (isDemo(j.tenant_id)) continue;
    let a = byAgent.get(j.agent_name);
    if (!a) {
      a = {
        agent: j.agent_name,
        runs_7d: 0,
        failed_7d: 0,
        runs_24h: 0,
        failed_24h: 0,
        last_run_at: null,
        last_status: null,
        last_error: null,
      };
      byAgent.set(j.agent_name, a);
    }
    const within24h = j.created_at >= since24h;
    a.runs_7d += 1;
    if (within24h) a.runs_24h += 1;
    if (j.status === 'failed') {
      a.failed_7d += 1;
      if (within24h) a.failed_24h += 1;
    }
    // data is newest-first, so the first row we see for an agent is its latest
    if (a.last_run_at === null) {
      a.last_run_at = j.completed_at || j.created_at;
      a.last_status = j.status;
      a.last_error = j.error || null;
    }
  }

  const agents = [...byAgent.values()].map((a) => {
    let status;
    if (a.runs_24h === 0) {
      status = 'idle'; // ran in last 7d but not last 24h — may be expected for weekly crons
    } else if (a.last_status === 'failed' || a.failed_24h / a.runs_24h >= 0.5) {
      status = 'down';
    } else if (a.failed_24h > 0) {
      status = 'degraded';
    } else {
      status = 'healthy';
    }
    return { ...a, status };
  });

  // Sort worst-first: down, then degraded, then idle, then healthy; ties by failures.
  const rank = { down: 0, degraded: 1, idle: 2, healthy: 3 };
  agents.sort((x, y) => (rank[x.status] - rank[y.status]) || (y.failed_24h - x.failed_24h) || x.agent.localeCompare(y.agent));
  return agents;
}

/** Platform output: 24h totals + 7-day daily baseline (demo excluded). */
async function fetchOutput(db, demoTenantIds) {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const demoIds = [...demoTenantIds];
  const exclude = (q) => (demoIds.length ? q.not('tenant_id', 'in', `(${demoIds.join(',')})`) : q);

  const countOf = (table, build) =>
    exclude(build(db.from(table).select('id', { count: 'exact', head: true })))
      .then((r) => r.count || 0)
      .catch(() => 0);

  const [leads24, leads7, posts24, posts7, sms24, sms7] = await Promise.all([
    countOf('leads', (q) => q.gte('created_at', since24h)),
    countOf('leads', (q) => q.gte('created_at', since7d)),
    countOf('content_drafts', (q) => q.eq('status', 'posted').gte('posted_at', since24h)),
    countOf('content_drafts', (q) => q.eq('status', 'posted').gte('posted_at', since7d)),
    countOf('messages', (q) => q.eq('channel', 'sms').eq('direction', 'outbound').gte('created_at', since24h)),
    countOf('messages', (q) => q.eq('channel', 'sms').eq('direction', 'outbound').gte('created_at', since7d)),
  ]);

  const mk = (label, today, week) => {
    const perDay = week / 7;
    return {
      label,
      today,
      per_day_avg: Math.round(perDay * 10) / 10,
      collapsed: perDay >= 1 && today === 0,
    };
  };
  return [
    mk('New leads', leads24, leads7),
    mk('Posts published', posts24, posts7),
    mk('SMS sent', sms24, sms7),
  ];
}

/** Operations Guardian incidents — active + recently recovered. */
async function fetchOpsIncidents(db) {
  const since7d = new Date(Date.now() - 7 * 86400_000).toISOString();
  const [openRes, recoveredRes] = await Promise.all([
    db.from('ops_incidents').select('*')
      .in('status', ['open', 'remediating', 'awaiting_approval', 'escalated'])
      .order('severity', { ascending: true }).order('detected_at', { ascending: false }).limit(50),
    db.from('ops_incidents').select('agent_name,issue_type,severity,resolved_at,remediation_result,verification_result')
      .eq('status', 'recovered').gte('resolved_at', since7d)
      .order('resolved_at', { ascending: false }).limit(25),
  ]);
  return { open: openRes.data || [], recovered: recoveredRes.data || [] };
}

async function buildSnapshot(db) {
  const { data: tenants } = await db.from('tenants').select('id,is_demo');
  const demoTenantIds = new Set((tenants || []).filter((t) => t.is_demo).map((t) => t.id));

  const [probes, agents, output] = await Promise.all([
    fetchLatestDependencyHealth(db),
    fetchAgentRollup(db, demoTenantIds),
    fetchOutput(db, demoTenantIds),
  ]);

  // The Targeted Campaign agent is idle-by-default (zero jobs unless a campaign
  // is executable), so it may have NO agent_jobs rows in the trailing 7d. Always
  // show its card so the operator can see "idle, 0 API usage" vs "missing".
  try {
    const { EXECUTABLE_STATUSES } = require('../../core/targeted-campaigns');
    const { count } = await db
      .from('targeted_campaigns')
      .select('id', { count: 'exact', head: true })
      .in('status', EXECUTABLE_STATUSES)
      .eq('kill_switch', false);
    const executable = count || 0;
    let card = agents.find((a) => a.agent === 'targeted-campaign');
    if (!card) {
      card = {
        agent: 'targeted-campaign',
        runs_7d: 0,
        failed_7d: 0,
        runs_24h: 0,
        failed_24h: 0,
        last_run_at: null,
        last_status: null,
        last_error: null,
        status: 'idle',
      };
      agents.push(card);
    }
    card.detail = executable > 0
      ? `${executable} executable campaign${executable === 1 ? '' : 's'}`
      : 'No executable campaigns — agent dormant, 0 API usage';
  } catch (e) {
    log.warn(`targeted-campaign card injection failed: ${e.message}`);
  }

  // Operations Guardian incidents (best-effort — never block the snapshot).
  let ops = { open: [], recovered: [] };
  try { ops = await fetchOpsIncidents(db); } catch (e) { log.warn(`ops incidents fetch failed: ${e.message}`); }

  const dependencies = probes.map(toDependencyCard);
  const downDeps = dependencies.filter((d) => d.status === 'down');
  const lastChecked = dependencies.reduce(
    (acc, d) => (d.checked_at && (!acc || d.checked_at > acc) ? d.checked_at : acc),
    null,
  );

  return {
    summary: {
      dependencies_total: dependencies.length,
      dependencies_down: downDeps.length,
      dependencies_degraded: dependencies.filter((d) => d.status === 'degraded').length,
      agents_total: agents.length,
      agents_down: agents.filter((a) => a.status === 'down').length,
      agents_degraded: agents.filter((a) => a.status === 'degraded').length,
      output_collapsed: output.filter((o) => o.collapsed).length,
      last_dependency_check: lastChecked,
      monitor_has_run: dependencies.length > 0,
      incidents_active: ops.open.length,
      incidents_need_approval: ops.open.filter((i) => i.requires_owner_approval).length,
      incidents_recovered_7d: ops.recovered.length,
    },
    dependencies,
    agents,
    output,
    operations_guardian: {
      incidents: ops.open,
      recovered: ops.recovered,
    },
  };
}

// GET / — full snapshot. If the monitor has never run, kick off one live sweep
// so the page is never blank on first load.
router.get('/', async (req, res) => {
  try {
    const db = getServiceClient();
    let snapshot = await buildSnapshot(db);
    if (!snapshot.summary.monitor_has_run) {
      log.info('No persisted probes yet — running one live sweep for first load');
      try {
        await checkPlatformHealth();
        snapshot = await buildSnapshot(db);
      } catch (e) {
        log.warn(`Live sweep on first load failed: ${e.message}`);
      }
    }
    res.json({ success: true, data: snapshot });
  } catch (err) {
    log.error(`Agent Hub snapshot failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /probe — run a live dependency sweep on demand (the "Run check now"
// button). checkPlatformHealth persists + alerts internally.
router.post('/probe', async (req, res) => {
  try {
    const results = await checkPlatformHealth();
    const db = getServiceClient();
    const snapshot = await buildSnapshot(db);
    res.json({ success: true, data: snapshot, probed: results.length });
  } catch (err) {
    log.error(`Agent Hub live probe failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
