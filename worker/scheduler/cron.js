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

const log = createLogger('scheduler');

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
  { agent: 'follow-up',            cron: '0 10,14 * * 1-5',   tz: TZ_ET, module: 'follow_up',         desc: 'SMS follow-up sequences (2x/day on weekdays, 10am+2pm ET)' },
  { agent: 'review-request',       cron: '0 10 * * *',        tz: TZ_ET, module: 'review_request',    desc: 'Post-job review asks (10am ET)' },
  { agent: 'referral-request',     cron: '0 14 * * *',        tz: TZ_ET, module: 'referral_engine',   desc: 'Post-job referral asks (2pm ET)' },

  // ── Content Pipeline (Mon + Thu cadence — Patrick 2026-05-12) ──
  { agent: 'campaign-orchestrator', cron: '0 11 * * 1',       tz: TZ_ET, module: 'content_engine',    desc: 'Weekly content pipeline (Mon 11am ET)' },
  { agent: 'content-generation',    cron: '0 11 * * 4',       tz: TZ_ET, module: 'content_engine',    desc: 'Second post of the week (Thu 11am ET)' },
  { agent: 'image-generation',      cron: '30 11 * * 1,4',    tz: TZ_ET, module: 'content_engine',    desc: 'Generate images (Mon/Thu 11:30am ET)' },
  { agent: 'distribution',          cron: '0 12 * * 1,4',     tz: TZ_ET, module: 'publishing',        desc: 'Adapt content for each platform (Mon/Thu noon ET)' },
  { agent: 'approval-queue',        cron: '0 13 * * 1-5',     tz: TZ_ET, module: 'publishing',        desc: 'Notify owner of pending approvals (1pm ET weekdays)' },
  // 'schedule' agent removed — Buffer's queue handles post timing now.
  { agent: 'publisher',             cron: '0 9 * * 1-5',      tz: TZ_ET, module: 'publishing',        desc: 'Send approved content to Buffer (9am ET weekdays)' },

  // ── Outreach & Prospecting ──
  // FGA business rule (2026-04-21): prospecting runs DAILY at 06:00 ET and
  // tops up the week toward 15 *qualified* leads. Industry rotates on Tue.
  { agent: 'prospecting',           cron: '0 6 * * *',        tz: TZ_ET, module: 'prospecting',       desc: 'Daily prospecting — top-up to 15 qualified/week (6am ET)' },
  { agent: 'enrichment',            cron: '0 8 * * 1-5',      tz: TZ_ET, module: 'prospecting',       desc: 'Enrichment sweeper for manual adds (8am ET weekdays)' },
  { agent: 'scoring',               cron: '30 7 * * 1-5',     tz: TZ_ET, module: 'lead_scoring',      desc: 'Score leads (7:30am ET weekdays)' },
  { agent: 'outreach',              cron: '0 9 * * 1-6',      tz: TZ_ET, module: 'referral_outreach', desc: 'Daily outreach — email drafts only (9am ET Mon-Sat)' },
  { agent: 'outreach',              cron: '0 18 * * 0',       tz: TZ_ET, module: 'referral_outreach', payload: { mode: 'fb_fallback' }, desc: 'Sunday 6pm ET — FB DM fallback if email count below target' },
  { agent: 'reply-classification',  cron: '30 * * * 1-5',     module: 'referral_outreach', desc: 'Hourly sweep for unclassified inbound replies (weekdays)' },
  { agent: 'clients-manager',       cron: '0 6 * * 1',        tz: TZ_ET, module: 'lead_capture',      desc: 'Weekly client health check (Mon 6am ET)' },

  // ── Intelligence ──
  { agent: 'chief-of-staff',        cron: '0 8,12,17 * * 1-5', tz: TZ_ET, module: 'email_chief',     desc: 'Email inbox management (8am/noon/5pm ET weekdays)' },
  { agent: 'meeting-prep',          cron: '0 8,14 * * 1-5',   tz: TZ_ET, module: 'lead_scoring',      desc: 'Meeting briefings (8am+2pm ET weekdays)' },
  { agent: 'advertising',           cron: '0 7 * * 1',        tz: TZ_ET, module: 'prospecting',       desc: 'Weekly ad performance analysis (Mon 7am ET)' },

  // ── Social & Engagement ──
  { agent: 'social-engagement',     cron: '0 10,14 * * *',    tz: TZ_ET, module: 'social_engagement', desc: 'Monitor & respond to social comments (10am+2pm ET)' },

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
  { agent: 'account-management',    cron: '0 6 * * 1',        tz: TZ_ET, module: 'branded_app',       desc: 'Weekly account health overview (Mon 6am ET)' },
  { agent: 'client-health',         cron: '0 7 * * 1',        tz: TZ_ET, module: 'branded_app',       desc: 'Weekly client health scoring (Mon 7am ET)' },
  { agent: 'reporting',             cron: '0 17 * * 5',       tz: TZ_ET, module: 'digest',            desc: 'Weekly business report (Fri 5pm ET)' },

  // ── Onboarding & Platform (always-on: module '*' means no module gating) ──
  { agent: 'onboarding-advance',       cron: '0 3 * * *',     tz: TZ_ET, module: '*', desc: 'Advance active onboarding workflows one day (3am ET)' },
  { agent: 'scheduled-email-dispatch', cron: '5 * * * *',     module: '*',           desc: 'Hourly drain of scheduled emails (onboarding check-ins, etc.)' },
  // Platform daily digest to Patrick @ 6:30am ET — after prospecting/enrichment
  // finish their 6am runs so the digest captures that day's activity.
  { agent: 'platform-daily-digest',    cron: '30 6 * * *',    tz: TZ_ET, module: '*', desc: 'Platform owner daily agent activity report (6:30am ET)' },
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
