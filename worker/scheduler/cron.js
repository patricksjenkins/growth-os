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
const SCHEDULE = [
  // ── Lead & Sales ──
  // speed-to-lead: new leads come in via POST /api/leads and enqueue a
  // job immediately (leads.js line 62). This scheduled sweeper is only a
  // safety net for leads inserted through a side channel. Previously ran
  // every 2 min — way too aggressive for a bootstrap phase. Hourly is
  // plenty for catching strays.
  { agent: 'speed-to-lead',        cron: '15 * * * *',        module: 'speed_to_lead',     desc: 'Hourly sweep for uncontacted new leads' },
  // 'missed-call' removed — fully event-driven via Twilio voice webhook.
  { agent: 'follow-up',            cron: '0 10,14 * * 1-5',   module: 'follow_up',         desc: 'SMS follow-up sequences (2x/day on weekdays)' },
  { agent: 'review-request',       cron: '0 10 * * *',        module: 'review_request',    desc: 'Post-job review asks' },
  { agent: 'referral-request',     cron: '0 14 * * *',        module: 'referral_engine',   desc: 'Post-job referral asks' },

  // ── Content Pipeline ──
  { agent: 'campaign-orchestrator', cron: '0 11 * * 1',       module: 'content_engine',    desc: 'Weekly content pipeline (generate + distribute)' },
  { agent: 'content-generation',    cron: '0 11 * * 3',       module: 'content_engine',    desc: 'Mid-week content batch' },
  { agent: 'image-generation',      cron: '30 11 * * 1,3',    module: 'content_engine',    desc: 'Generate images for content' },
  { agent: 'distribution',          cron: '0 12 * * 1,3',     module: 'publishing',        desc: 'Adapt content for each platform' },
  { agent: 'approval-queue',        cron: '0 13 * * 1-5',     module: 'publishing',        desc: 'Notify owner of pending approvals' },
  // 'schedule' agent removed — Buffer's queue handles post timing now.
  { agent: 'publisher',             cron: '0 9 * * 1-5',      module: 'publishing',        desc: 'Send approved content to Buffer queue' },

  // ── Outreach & Prospecting ──
  // FGA business rule (2026-04-21): prospecting runs DAILY at 06:00 ET and
  // tops up the week toward 15 *qualified* leads (= ICP pass + enrichment
  // found email or Facebook URL). Industry rotates on Tuesday only; other
  // days just fill the remainder of the current week's industry.
  { agent: 'prospecting',           cron: '0 6 * * *',        tz: 'America/New_York', module: 'prospecting', desc: 'Daily prospecting — top-up to 15 qualified/week' },
  // Enrichment runs inline from prospecting now, but this scheduled sweeper
  // catches any stragglers (e.g. manually-added leads) at 08:00 ET weekdays.
  { agent: 'enrichment',            cron: '0 8 * * 1-5',      tz: 'America/New_York', module: 'prospecting', desc: 'Enrichment sweeper (catches manual adds)' },
  { agent: 'scoring',               cron: '30 7 * * 1-5',     module: 'lead_scoring',      desc: 'Score leads' },
  // Weekday outreach: email-only mode. Drafts emails for qualified leads.
  { agent: 'outreach',              cron: '0 9 * * 1-6',      tz: 'America/New_York', module: 'referral_outreach', desc: 'Daily outreach — email drafts only' },
  // Sunday: if the week didn't hit 15 emails, draft FB DMs from the fb_only
  // pool as a fallback so Patrick still has something to work through.
  { agent: 'outreach',              cron: '0 18 * * 0',       tz: 'America/New_York', module: 'referral_outreach', payload: { mode: 'fb_fallback' }, desc: 'Sunday FB DM fallback if email count below target' },
  // reply-classification: classifies inbound SMS replies. Twilio webhook
  // fires on receipt so this scheduled run is only a sweeper. Hourly.
  { agent: 'reply-classification',  cron: '30 * * * 1-5',     module: 'referral_outreach', desc: 'Hourly sweep for unclassified inbound replies (weekdays)' },
  { agent: 'clients-manager',       cron: '0 6 * * 1',        module: 'lead_capture',      desc: 'Weekly client health check' },

  // ── Intelligence ──
  { agent: 'chief-of-staff',        cron: '0 8,12,17 * * 1-5', module: 'email_chief',     desc: 'Email inbox management' },
  { agent: 'meeting-prep',          cron: '0 8,14 * * 1-5',   module: 'lead_scoring',      desc: 'Generate meeting briefings' },
  { agent: 'advertising',           cron: '0 7 * * 1',        module: 'prospecting',       desc: 'Weekly ad performance analysis' },

  // ── Social & Engagement ──
  { agent: 'social-engagement',     cron: '0 10,14 * * *',    module: 'social_engagement', desc: 'Monitor & respond to social comments' },

  // ── Notifications ──
  // Push: drains the notifications queue for devices registered via the
  // mobile app. Queued rows get created event-driven (from other agents);
  // this is just the drain. Hourly is fine — ops teams don't care if
  // a non-urgent push lands within the hour.
  { agent: 'notification-push',     cron: '45 * * * *',       module: 'branded_app',       desc: 'Hourly drain of pending push notifications' },
  // In-app notifications queue — hourly is fine for the same reason.
  { agent: 'notifications',         cron: '50 * * * *',       module: 'branded_app',       desc: 'Hourly drain of in-app notifications' },

  // ── Digest ──
  { agent: 'digest',                cron: '0 17 * * 1-5',     module: 'digest',            desc: 'End-of-day summary' },

  // ── Back-Office & Financial Operations ──
  { agent: 'billing',               cron: '0 6 1 * *',        module: 'finance',           desc: 'Monthly billing analysis & alerts' },
  { agent: 'bookkeeping',           cron: '0 6 * * 1',        module: 'finance',           desc: 'Weekly bookkeeping health check' },
  { agent: 'financial-dashboard',   cron: '0 7 * * 1-5',      module: 'finance',           desc: 'Daily financial KPI snapshot' },
  { agent: 'tax-prep',              cron: '0 6 1 1,4,7,10 *', module: 'finance',           desc: 'Quarterly tax estimate' },
  { agent: 'account-management',    cron: '0 6 * * 1',        module: 'branded_app',       desc: 'Weekly account health overview' },
  { agent: 'client-health',         cron: '0 7 * * 1',        module: 'branded_app',       desc: 'Weekly client health scoring' },
  { agent: 'reporting',             cron: '0 17 * * 5',       module: 'digest',            desc: 'Weekly business report' },

  // ── Onboarding & Platform (always-on: module '*' means no module gating) ──
  { agent: 'onboarding-advance',       cron: '0 3 * * *',     module: '*', desc: 'Advance active onboarding workflows one day' },
  // Scheduled-email-dispatch: sends onboarding check-ins with a future
  // send_at. Granularity of 1 hour is fine — a Day-21 check-in landing
  // at 10:00 vs 10:15 doesn't matter.
  { agent: 'scheduled-email-dispatch', cron: '5 * * * *',    module: '*', desc: 'Hourly drain of scheduled emails (onboarding check-ins, etc.)' },
  { agent: 'platform-daily-digest',    cron: '0 7 * * *',     module: '*', desc: 'Platform owner daily agent activity report (guards to platform tenant only)' },
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
