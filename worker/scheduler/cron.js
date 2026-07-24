/**
 * Growth OS — Tenant-Aware Cron Scheduler
 * Single source of truth for all scheduled agent runs. Replaces n8n.
 */

const cron = require('node-cron');
const { createLogger } = require('../../core/logger');
const { isModuleEnabled } = require('../../core/modules');
const { getAllActiveTenants } = require('../../db/queries/config');
const { enqueueJob } = require('../../db/queries/jobs');
const { resolveTenant } = require('../../core/tenant');
const { getServiceClient } = require('../../db/client');

const { isPlannerEnabled } = require('../../core/content/planner-flags');
const contentPlanAgent = require('../agents/content-plan');
const { FGA_TENANT_ID } = require('../../core/config');

const log = createLogger('scheduler');

// Platform/FGA-only gate for internal coordination agents (orchestrator), so we
// don't enqueue no-op jobs for client tenants. Mirrors the agents' own guard.
const isFGAlike = (t) =>
  t.id === FGA_TENANT_ID || t.slug === 'fga' || t.slug === 'platform' ||
  t.tier === 'platform' || t.is_platform === true;

// True when this tenant has an owner-approved concept for the given slot in the
// CURRENT week — used to gate the Mon/Thu finalize runs (idle-by-default, no
// enqueue unless the concept was approved). Fail-safe: any error → false.
async function hasApprovedConceptForSlot(tenant, slot) {
  try {
    const weekStart = contentPlanAgent.computeWeekStart();
    const { data } = await getServiceClient()
      .from('content_plan_concepts')
      .select('id, content_plans!inner(week_start_date)')
      .eq('tenant_id', tenant.id)
      .eq('slot', slot)
      .eq('status', 'concept_approved')
      .eq('content_plans.week_start_date', weekStart)
      .limit(1);
    return !!(data && data.length);
  } catch (_) { return false; }
}

/**
 * Schedule definitions
 * Each entry: { agent, cron expression, required module }
 */
// RULE: any schedule with an explicit clock time (e.g. "6am", "5pm") MUST set
// tz: 'America/New_York'. Without it, node-cron runs in the process's TZ (UTC
// on Railway) so a cron like '0 7 * * *' fires at 07:00 UTC = 03:00 ET — which
// is how the platform-daily-digest ended up in Patrick's inbox at 3am.
// Hourly sweeps (everything on :15, :30, :45, :50, :05 of every hour) don't
// need a timezone because they fire every hour regardless.
const TZ_ET = 'America/New_York';

const SCHEDULE = [
  // ── Lead & Sales ──
  // speed-to-lead: new leads come in via POST /api/leads and enqueue a
  // job immediately (leads.js line 62). This scheduled sweeper is only a
  // safety net for leads inserted through a side channel. Hourly is plenty.
  { agent: 'speed-to-lead',        cron: '15 * * * *',        module: 'speed_to_lead',     desc: 'Hourly sweep for uncontacted new leads' },
  // 'missed-call' removed — fully event-driven via Twilio voice webhook.
  { agent: 'follow-up',            cron: '0 11 * * 1,3,5',    tz: TZ_ET, module: 'follow_up',         desc: 'Follow-up sequences — once/day, Mon/Wed/Fri at 11am ET (dropped from 2x/day 2026-05-21 after over-firing)' },
  // Module 4.7 — Past-customer re-engagement. Weekly sweep over won leads
  // whose updated_at is older than past_customer_reengagement_months
  // (default 6). Agent has its own quarterly idempotency so re-running
  // the cron more often is safe.
  { agent: 'past-customer-reengagement', cron: '0 9 * * 3',   tz: TZ_ET, module: 'follow_up',         desc: 'Weekly past-customer re-engagement (Wed 9am ET)' },
  // Sales-nurture (FGA-only). Daily 9am ET. Internal cadence config inside the
  // agent decides which leads are due: demo_booked >3 days, trial_active day 7
  // + day 13, nurture stage every 30 days. Idempotent per (lead, intent,
  // period) so daily runs are safe.
  { agent: 'sales-nurture',        cron: '0 9 * * *',         tz: TZ_ET, module: '*',                 desc: 'FGA sales-nurture cadences (daily 9am ET — demo follow-up, trial check-ins, nurture monthly)' },
  { agent: 'review-request',       cron: '0 10 * * *',        tz: TZ_ET, module: 'review_request',    desc: 'Post-job review asks (10am ET)' },
  { agent: 'referral-request',     cron: '0 14 * * *',        tz: TZ_ET, module: 'referral_engine',   desc: 'Post-job referral asks (2pm ET)' },
  // Partner Outreach (Module 11): keep referral partners (realtors, contractors,
  // bookkeepers, etc.) warm. Runs 3x/week — agent's decideAction() filters out
  // partners not yet due so the per-day touch count stays well under the cap.
  { agent: 'partner-outreach',     cron: '0 11 * * 2,4',      tz: TZ_ET, module: 'partner_outreach',  desc: 'Partner check-ins (Tue+Thu 11am ET)' },
  { agent: 'partner-outreach',     cron: '0 9 * * 1',         tz: TZ_ET, module: 'partner_outreach',  desc: 'Weekly partner sweep (Mon 9am ET)' },

  // ── Content Pipeline (Mon + Thu cadence — Patrick 2026-05-14 simplified) ──
  // Mon and Thu each fire `content-generation` directly (one draft per day).
  // content-generation calls image-generation inline, so the carousel is built
  // in the same run. The single draft is sent to Buffer; Buffer's linked
  // Instagram/Facebook account cross-posts so we don't need per-platform
  // variants. This replaced the earlier 4-step pipeline (orchestrator →
  // generate 4 posts → distribution → per-platform variants) which was
  // overproducing drafts for FGA's weekly cadence.
  // LEGACY direct path (format-first) — now gated to planner-DISABLED tenants
  // only (client tenants). For FGA the strategy-first planner below replaces
  // this so we never double-produce. The `when:!isPlannerEnabled` guard is
  // load-bearing — see test/content/cron-gating.test.js.
  { agent: 'content-generation',    cron: '0 11 * * 1',       tz: TZ_ET, module: 'content_engine', when: (t) => !isPlannerEnabled(t), desc: 'Legacy first post of the week (Mon 11am ET) — planner-OFF tenants' },
  { agent: 'content-generation',    cron: '0 11 * * 4',       tz: TZ_ET, module: 'content_engine', when: (t) => !isPlannerEnabled(t), desc: 'Legacy second post of the week (Thu 11am ET) — planner-OFF tenants' },
  { agent: 'image-generation',      cron: '30 11 * * 1,4',    tz: TZ_ET, module: 'content_engine',    desc: 'Safety-net sweep for drafts missing images (Mon/Thu 11:30am ET)' },

  // STRATEGY-FIRST planner (FGA-gated). Sunday builds 2 concepts (Claude only,
  // no image cost) and notifies the owner. Mon/Thu finalize ONLY a concept the
  // owner approved — idle by default, so an un-approved plan never publishes.
  { agent: 'content-plan',          cron: '40 18 * * 0',      tz: TZ_ET, module: 'content_engine', when: (t) => isPlannerEnabled(t), desc: 'Weekly strategy plan — 2 concepts (Sun 6:40pm ET)' },
  { agent: 'content-concept-finalize', cron: '5 11 * * 1',    tz: TZ_ET, module: 'content_engine', payload: { slot: 'monday' },   when: (t) => hasApprovedConceptForSlot(t, 'monday'),   desc: 'Finalize approved Monday concept (Mon 11:05am ET)' },
  { agent: 'content-concept-finalize', cron: '5 11 * * 4',    tz: TZ_ET, module: 'content_engine', payload: { slot: 'thursday' }, when: (t) => hasApprovedConceptForSlot(t, 'thursday'), desc: 'Finalize approved Thursday concept (Thu 11:05am ET)' },
  { agent: 'approval-queue',        cron: '0 13 * * 1-5',     tz: TZ_ET, module: 'publishing',        desc: 'Notify owner of pending approvals (1pm ET weekdays)' },
  // 'distribution' agent removed from cron — Buffer's IG↔FB linked account
  // handles cross-posting, so we don't need to fork a draft per platform.
  // The distribution agent itself still exists for tenants that explicitly
  // want platform-adapted captions; it just isn't scheduled by default.
  // 'schedule' agent removed — Buffer's queue handles post timing now.
  { agent: 'publisher',             cron: '0 9 * * 1-5',      tz: TZ_ET, module: 'publishing',        desc: 'Send approved content to Buffer (9am ET weekdays)' },

  // ── Outreach & Prospecting ──
  // FGA business rule (2026-04-21 → 2026-06-11 scale-up): prospecting runs
  // DAILY at 06:00 ET and tops up the week toward 50 *qualified* leads with
  // daily pacing. A SET of 3-5 industries rotates on Tue. Hard weekly ceiling.
  { agent: 'prospecting',           cron: '0 6 * * *',        tz: TZ_ET, module: 'prospecting',       desc: 'Daily prospecting — multi-industry top-up to 50 qualified/week (6am ET)' },
  { agent: 'enrichment',            cron: '0 8 * * 1-5',      tz: TZ_ET, module: 'prospecting',       desc: 'Enrichment sweeper for manual adds (8am ET weekdays)' },
  { agent: 'scoring',               cron: '30 7 * * 1-5',     tz: TZ_ET, module: 'lead_scoring',      desc: 'Score leads (7:30am ET weekdays)' },
  { agent: 'outreach',              cron: '0 9 * * 1-6',      tz: TZ_ET, module: 'outreach_drip', desc: 'Daily outreach — email drafts only (9am ET Mon-Sat)' },
  { agent: 'outreach',              cron: '0 18 * * 0',       tz: TZ_ET, module: 'outreach_drip', payload: { mode: 'fb_fallback' }, desc: 'Sunday 6pm ET — FB DM fallback if email count below target' },
  // Autonomous first-touch dispatcher (2026-07-03). IDLE BY DEFAULT — the
  // `when` predicate only enqueues once FGA arms autonomous mode via
  // tenant_config autonomous_outreach_enabled='true', so a dormant agent
  // produces zero jobs. Three business-hour windows spread sends across the
  // day (deliverability + reads human); Monday's ramp-review run raises the
  // daily cap by +10 after a clean week (never past autosend_daily_max).
  { agent: 'auto-outreach',         cron: '20 9,12,15 * * 1-6', tz: TZ_ET, module: 'outreach_drip',
    when: (t) => {
      const { getConfig } = require('../../core/config');
      return String(getConfig(t, 'autonomous_outreach_enabled', 'false')) === 'true';
    },
    desc: 'Autonomous outreach dispatch — gated auto-sends (9:20am/12:20pm/3:20pm ET Mon-Sat)' },
  { agent: 'auto-outreach',         cron: '5 8 * * 1',        tz: TZ_ET, module: 'outreach_drip',
    payload: { task: 'ramp_review' },
    when: (t) => {
      const { getConfig } = require('../../core/config');
      return String(getConfig(t, 'autonomous_outreach_enabled', 'false')) === 'true';
    },
    desc: 'Autonomous outreach ramp review — raise daily cap after a clean week (Mon 8:05am ET)' },
  // Facebook-prospecting (added 2026-05-26): handles fb_only leads the
  // enrichment agent couldn't find an email for. Two SMS touches (Day 0 +
  // Day 7) + one manual FB DM draft on Day 0. Daily 2pm ET so SMS never
  // fires before 11am Pacific. Default mode runs day0 + day7 + post7 in
  // sequence. Monthly mode re-enriches the bucket to graduate prospects
  // into the regular email-outreach path once a real email is found.
  { agent: 'facebook-prospecting',  cron: '0 14 * * *',       tz: TZ_ET, module: 'prospecting',       desc: 'FB-only outreach — Day 0 SMS + FB draft, Day 7 follow-up, post-7 → nurture (2pm ET daily)' },
  { agent: 'facebook-prospecting',  cron: '0 8 1 * *',        tz: TZ_ET, module: 'prospecting',       payload: { mode: 'reenrich' }, desc: 'Monthly re-enrich of fb-only bucket — 1st of month 8am ET' },
  // Targeted Campaign agent (2026-06-11): IDLE BY DEFAULT. The per-tenant
  // `when` predicate does ONE cheap DB count of executable campaigns
  // (ready_for_pilot / pilot_running / approved_to_continue / active with
  // kill_switch off) — when 0, the job is NOT enqueued at all, so a dormant
  // agent produces zero jobs and zero API calls. Completely separate from
  // the standard prospecting agent above.
  {
    agent: 'targeted-campaign', cron: '30 6 * * *', tz: TZ_ET, module: 'prospecting',
    when: async (tenant) => {
      const { countExecutableCampaigns } = require('../../core/targeted-campaigns');
      return (await countExecutableCampaigns(tenant.id)) > 0;
    },
    desc: 'Targeted campaign daily batches — only enqueues when a campaign is executable (6:30am ET)',
  },
  { agent: 'reply-classification',  cron: '30 * * * 1-5',     module: 'outreach_drip', desc: 'Hourly sweep for unclassified inbound replies (weekdays)' },

  // ── 923A Commercial & Event Opportunity discovery (923A-ONLY) ──
  // Idle by default: every `when` predicate short-circuits for non-923A tenants
  // (free slug check) and only enqueues when 923A discovery is enabled, not
  // paused, and under its isolated $15/mo budget. Writes into 923A's front-door
  // Supabase. module '*' = no growth-os module gating (923A isn't a normal tenant
  // here); the gate is the `when` predicate. Separate from the Federal agent.
  { agent: 'commercial-discovery', cron: '15 7 * * *', tz: TZ_ET, module: '*', payload: { mode: 'daily_monitor' },
    when: (t) => require('../../core/commercial/gate').monitorEnabled(t),
    desc: '923A daily monitor — recompute buying windows/stages (7:15am ET)' },
  { agent: 'commercial-discovery', cron: '15 6 * * 2', tz: TZ_ET, module: '*', payload: { mode: 'discovery_tue' },
    when: (t) => require('../../core/commercial/gate').discoveryAllowed(t),
    desc: '923A Tuesday discovery — endurance/community/military (6:15am ET)' },
  { agent: 'commercial-discovery', cron: '15 6 * * 4', tz: TZ_ET, module: '*', payload: { mode: 'discovery_thu' },
    when: (t) => require('../../core/commercial/gate').discoveryAllowed(t),
    desc: '923A Thursday discovery — sports/schools/corporate/conferences/clubs (6:15am ET)' },
  { agent: 'commercial-discovery', cron: '0 7 * * 6', tz: TZ_ET, module: '*', payload: { mode: 'quality' },
    when: (t) => require('../../core/commercial/gate').monitorEnabled(t),
    desc: '923A Saturday quality run — recompute + close past events (7:00am ET)' },
  { agent: 'commercial-discovery', cron: '30 7 * * 0', tz: TZ_ET, module: '*', payload: { mode: 'monthly' },
    when: async (t) => {
      // First Sunday of the month only (ET date), and discovery allowed.
      const day = Number(new Date().toLocaleDateString('en-US', { timeZone: TZ_ET, day: 'numeric' }));
      if (day > 7) return false;
      return require('../../core/commercial/gate').discoveryAllowed(t);
    },
    desc: '923A monthly deep refresh — first Sunday, extended horizon (7:30am ET)' },
  // Targeted-search consumer — frequent during business hours, but only enqueues
  // when a queued request exists (idle-by-default). Claims one request per run.
  { agent: 'commercial-discovery', cron: '20 9-17 * * 1-5', tz: TZ_ET, module: '*', payload: { mode: 'targeted_search' },
    when: (t) => require('../../core/commercial/gate').hasQueuedTargeted(t),
    desc: '923A targeted-search consumer — :20 hourly 9am-5pm ET weekdays (only when a request is queued)' },

  // ── Drip Campaign (FGA-only — agent guards tenant.id internally) ──
  // Sends fire every 30 min inside the 9:00-11:30am ET weekday window; each
  // enrollment's next_send_at already carries prospect-local jitter, so the
  // sweep only dispatches what's due. Outside-window due rows get rescheduled
  // by the agent itself.
  { agent: 'drip-campaign',         cron: '0,30 9-11 * * 1-5', tz: TZ_ET, module: '*', desc: 'Drip campaign sends — every 30 min, 9-11:30am ET weekdays (FGA-only)' },
  // Gmail reply sync: classify inbound (genuine / OOO / bounce / unsub /
  // ambiguous) and route enrollments. Hourly during business hours.
  { agent: 'drip-campaign',         cron: '15 8-18 * * 1-5',   tz: TZ_ET, module: '*', payload: { task: 'sync_replies' }, desc: 'Drip Gmail reply sync — hourly 8am-6pm ET weekdays (FGA-only)' },
  // ── Outreach Center cadence (2026-06-20) — IDLE BY DEFAULT ──
  // Advances due Outreach enrollments: builds the next touch as a draft for
  // owner approval (auto-send is opt-in per type, follow-ups only). The `when`
  // predicate does ONE cheap count of active+due enrollments — when 0, nothing
  // is enqueued (zero work / zero API calls for tenants not using it).
  { agent: 'outreach-cadence', cron: '0 10,13,16 * * *', tz: TZ_ET, module: '*',
    when: async (tenant) => {
      const { db } = require('../../db/client');
      const { count } = await db.from('outreach_enrollments')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenant.id).eq('status', 'active').lte('next_send_at', new Date().toISOString());
      return (count || 0) > 0;
    },
    desc: 'Outreach Center cadence — advances due enrollments (10am/1pm/4pm ET; only when work is due)' },
  { agent: 'clients-manager',       cron: '0 6 * * 1',        tz: TZ_ET, module: 'lead_capture',      desc: 'Weekly client health check (Mon 6am ET)' },
  // Gmail invoice scan (FGA-only). Read-only sweep of every connected inbox for
  // invoice/receipt attachments -> PENDING drafts in the Expenses review inbox.
  // 14-day lookback on a 7-day cadence: the overlap means a week where the run
  // failed (dead token, Gmail 5xx) still catches its invoices on the next pass.
  // Nothing is ever auto-approved and the mailbox is never modified.
  { agent: 'invoice-scan',          cron: '0 7 * * 1',        tz: TZ_ET, module: '*',                   desc: 'Weekly Gmail invoice scan (Mon 7am ET, FGA-only) — drafts to Needs Review' },

  // ── Intelligence ──
  { agent: 'chief-of-staff',        cron: '0 8,12,17 * * 1-5', tz: TZ_ET, module: 'email_chief',     desc: 'Email inbox management (8am/noon/5pm ET weekdays)' },
  { agent: 'meeting-prep',          cron: '0 8,14 * * 1-5',   tz: TZ_ET, module: 'lead_scoring',      desc: 'Meeting briefings (8am+2pm ET weekdays)' },
  { agent: 'advertising',           cron: '0 7 * * 1',        tz: TZ_ET, module: 'prospecting',       desc: 'Weekly ad performance analysis (Mon 7am ET)' },

  // ── Voice Receptionist (Module 9) ──
  // No cron — voice-receptionist is fully event-driven via the Twilio
  // /webhooks/voice-receptionist endpoint and the Vapi.ai server callback
  // /webhooks/voice-receptionist/complete. Listed here for documentation only.

  // ── Notifications (hourly drains — tz-agnostic) ──
  { agent: 'notification-push',     cron: '45 * * * *',       module: 'branded_app',       desc: 'Hourly drain of pending push notifications' },
  { agent: 'notifications',         cron: '50 * * * *',       module: 'branded_app',       desc: 'Hourly drain of in-app notifications' },

  // ── Digest ──
  { agent: 'digest',                cron: '0 17 * * 1-5',     tz: TZ_ET, module: 'digest',            desc: 'End-of-day summary (5pm ET weekdays)' },

  // ── Back-Office & Financial Operations ──
  { agent: 'billing',               cron: '0 6 1 * *',        tz: TZ_ET, module: 'finance',           desc: 'Monthly billing analysis (1st of month, 6am ET)' },
  { agent: 'bookkeeping',           cron: '0 6 * * 1',        tz: TZ_ET, module: 'finance',           desc: 'Weekly bookkeeping health check (Mon 6am ET)' },
  { agent: 'financial-dashboard',   cron: '0 7 * * 1-5',      tz: TZ_ET, module: 'finance',           desc: 'Daily financial KPI snapshot (7am ET weekdays)' },
  { agent: 'tax-prep',              cron: '0 6 1 1,4,7,10 *', tz: TZ_ET, module: 'finance',           desc: 'Quarterly tax estimate (Jan/Apr/Jul/Oct 1st, 6am ET)' },
  // Stretch enhancements (BI & Financial Sync §8 + §10)
  { agent: 'audit-dry-run',         cron: '0 7 1 1,4,7,10 *', tz: TZ_ET, module: 'finance',           desc: 'Quarterly IRS-audit dry run (Jan/Apr/Jul/Oct 1st, 7am ET)' },
  { agent: 'nexus-monitor',         cron: '0 7 1 * *',        tz: TZ_ET, module: 'finance',           desc: 'Monthly sales-tax nexus check (1st of month, 7am ET)' },
  { agent: 'churn-risk-detector',   cron: '0 8 * * *',        tz: TZ_ET, module: 'finance',           desc: 'Daily per-tenant churn risk scoring (8am ET)' },
  { agent: 'threshold-alerts',      cron: '30 8 * * *',       tz: TZ_ET, module: 'finance',           desc: 'Daily critical-metric threshold scan + push (8:30am ET)' },
  { agent: 'mercury-sync',          cron: '0 5 * * *',        tz: TZ_ET, module: '*',                 desc: 'Daily Mercury balance + transaction pull (5am ET, FGA-only)' },
  { agent: 'account-management',    cron: '0 6 * * 1',        tz: TZ_ET, module: 'branded_app',       desc: 'Weekly account health overview (Mon 6am ET)' },
  { agent: 'client-health',         cron: '0 7 * * 1',        tz: TZ_ET, module: 'branded_app',       desc: 'Weekly client health scoring (Mon 7am ET)' },
  { agent: 'reporting',             cron: '0 17 * * 5',       tz: TZ_ET, module: 'digest',            desc: 'Weekly business report (Fri 5pm ET)' },

  // ── Onboarding & Platform (always-on: module '*' means no module gating) ──
  { agent: 'onboarding-advance',       cron: '0 3 * * *',     tz: TZ_ET, module: '*', desc: 'Advance active onboarding workflows one day (3am ET)' },
  { agent: 'scheduled-email-dispatch', cron: '5 * * * *',     module: '*',           desc: 'Hourly drain of scheduled emails (onboarding check-ins, etc.)' },
  // Platform daily digest to Patrick @ 6:30am ET — after prospecting/enrichment
  // finish their 6am runs so the digest captures that day's activity.
  { agent: 'platform-daily-digest',    cron: '30 6 * * *',    tz: TZ_ET, module: '*', desc: 'Platform owner daily agent activity report (6:30am ET)' },
  // Probes every external dependency (Serper/Anthropic/Gemini/Telnyx/Buffer) +
  // platform services every 3h, persists to platform_health_checks, and
  // CRITICAL-alerts on any outage. Interval cron (no clock-time) so tz is
  // irrelevant. 8 runs/day = ~8 Serper credits/day for the probe.
  { agent: 'system-monitor',           cron: '0 */3 * * *',   module: '*', desc: 'Probe all dependencies + services, alert on outage (every 3h)' },
  // Operations Guardian — agent-level self-healing sweep. Runs every 3h ET so
  // the 6:00am ET sweep refreshes incidents just before the 6:30am digest.
  // Read-only detection + bounded Level-1 requeues + escalation. No paid API.
  { agent: 'operations-guardian',      cron: '0 */3 * * *',   tz: TZ_ET, module: '*', desc: 'Agent-level self-healing: detect/remediate/escalate outages (every 3h ET)' },
  // Completed-day internal reports only. Exact FGA write cohort and the agent's
  // own no-outreach boundary must both pass before any report RPC is called.
  { agent: 'supervised-executive-foundation', cron: '45 6 * * *', tz: TZ_ET, module: '*',
    when: (t) => isFGAlike(t)
      && require('../../core/autonomous-os/feature-flags').flags.departmentHeadWrites()
      && require('../../core/autonomous-os/cohort').tenantInCohort(
        t.id, 'FGA_OS_DEPARTMENT_HEAD_WRITE_TENANT_ALLOWLIST'
      ),
    desc: 'FGA Reliability + Revenue completed-day supervised reports (6:45am ET)' },
  // Prospecting Orchestrator — 3 light coordination sweeps/day (after the 6am
  // prospecting run, midday, late afternoon). Rules-based, no sends, no paid
  // API; just refreshes the Growth Engine funnel + Next Best Actions snapshot.
  // FGA-only via the `when` gate so no no-op jobs are enqueued for clients.
  { agent: 'prospecting-orchestrator', cron: '15 6,12,17 * * *', tz: TZ_ET, module: '*', when: (t) => isFGAlike(t), desc: 'Growth Engine snapshot — funnel + Next Best Actions (3×/day ET, FGA-only)' },

  // ── Usage reset ──
  // Resets per-tenant monthly counters in tenant_usage on the 1st of
  // every month at 00:05 UTC. Daily counters self-heal via the date
  // check in core/usage-caps.js, so we don't need a separate daily reset.
  { agent: 'monthly-usage-reset',      cron: '5 0 1 * *',                module: '*', desc: 'Reset per-tenant monthly usage counters (1st of month, 00:05 UTC)' },
];

/**
 * Start all cron jobs
 */
function startScheduler() {
  log.info(`Registering ${SCHEDULE.length} scheduled jobs`);

  for (const job of SCHEDULE) {
    const options = job.tz ? { timezone: job.tz } : undefined;
    cron.schedule(job.cron, async () => {
      log.info(`Cron fired: ${job.agent} (${job.desc})`);

      try {
        const tenants = await getAllActiveTenants();
        const supabase = getServiceClient();

        for (const tenantRow of tenants) {
          const tenant = await resolveTenant(supabase, tenantRow.id);

          // Skip demo tenants entirely — they're sales tools, not real
          // businesses. Running agents against them wastes compute, fills
          // agent_jobs/agent_activity_log with noise that distorts platform
          // health reports, and the demo-guard already blocks real SMS /
          // email / social sends downstream anyway. A demo tenant should
          // only "come alive" when a prospect is actively tapping around,
          // which is driven by the mobile app, not cron.
          if (tenant.is_demo) {
            continue;
          }

          // module: '*' (or null) means always-on — runs for every tenant
          // regardless of which modules they've enabled. Used for platform
          // jobs like onboarding-advance and scheduled-email-dispatch.
          const alwaysOn = !job.module || job.module === '*';
          if (alwaysOn || isModuleEnabled(tenant, job.module)) {
            // Optional per-tenant `when` predicate (async tenant => boolean):
            // a cheap DB-only check that lets idle-by-default agents (e.g.
            // targeted-campaign) skip enqueueing entirely. Fail-safe: a
            // predicate error means "do not enqueue".
            if (typeof job.when === 'function') {
              let shouldRun = false;
              try { shouldRun = await job.when(tenant); } catch (whenErr) {
                log.warn(`when() failed for ${job.agent}/${tenantRow.slug}: ${whenErr.message}`);
              }
              if (!shouldRun) continue;
            }
            // Scheduler passes job.payload through to the job processor,
            // so a cron entry can target a specific agent mode (e.g. the
            // Sunday FB fallback for outreach).
            await enqueueJob(tenantRow.id, job.agent, job.payload || {});
            log.info(`Enqueued ${job.agent} for ${tenantRow.slug}`);
          }
        }
      } catch (err) {
        log.error(`Scheduler error for ${job.agent}`, err);
      }
    }, options);

    const tzTag = job.tz ? ` [${job.tz}]` : '';
    log.info(`  ${job.cron.padEnd(20)} → ${job.agent}${tzTag} (${job.desc})`);
  }

  log.success('Scheduler started');
}

function getSchedule() {
  return SCHEDULE;
}

module.exports = { startScheduler, getSchedule };
