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
  { agent: 'speed-to-lead',        cron: '*/2 * * * *',       module: 'speed_to_lead',     desc: 'Catch new leads, instant SMS' },
  // 'missed-call' removed — fully event-driven via Twilio voice webhook.
  { agent: 'follow-up',            cron: '0 8-18 * * 1-5',    module: 'follow_up',         desc: 'SMS follow-up sequences' },
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
  { agent: 'prospecting',           cron: '0 6 * * 1-5',      module: 'prospecting',       desc: 'Find new prospects' },
  { agent: 'enrichment',            cron: '0 7 * * 1-5',      module: 'prospecting',       desc: 'Enrich prospect data' },
  { agent: 'scoring',               cron: '30 7 * * 1-5',     module: 'lead_scoring',      desc: 'Score leads' },
  { agent: 'outreach',              cron: '0 9 * * 1-5',      module: 'referral_outreach', desc: 'Generate outreach drip sequences' },
  { agent: 'reply-classification',  cron: '*/15 * * * 1-5',   module: 'referral_outreach', desc: 'Classify inbound replies' },
  { agent: 'clients-manager',       cron: '0 6 * * 1',        module: 'lead_capture',      desc: 'Weekly client health check' },

  // ── Intelligence ──
  { agent: 'chief-of-staff',        cron: '0 8,12,17 * * 1-5', module: 'email_chief',     desc: 'Email inbox management' },
  { agent: 'meeting-prep',          cron: '0 8,14 * * 1-5',   module: 'lead_scoring',      desc: 'Generate meeting briefings' },
  { agent: 'advertising',           cron: '0 7 * * 1',        module: 'prospecting',       desc: 'Weekly ad performance analysis' },

  // ── Social & Engagement ──
  { agent: 'social-engagement',     cron: '0 10,14 * * *',    module: 'social_engagement', desc: 'Monitor & respond to social comments' },

  // ── Notifications ──
  { agent: 'notification-push',     cron: '*/5 * * * *',      module: 'branded_app',       desc: 'Send push notifications' },
  { agent: 'notifications',         cron: '*/10 * * * *',     module: 'branded_app',       desc: 'Process notification queue' },

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
];

/**
 * Start all cron jobs
 */
function startScheduler() {
  log.info(`Registering ${SCHEDULE.length} scheduled jobs`);

  for (const job of SCHEDULE) {
    cron.schedule(job.cron, async () => {
      log.info(`Cron fired: ${job.agent} (${job.desc})`);

      try {
        const tenants = await getAllActiveTenants();
        const supabase = getServiceClient();

        for (const tenantRow of tenants) {
          const tenant = await resolveTenant(supabase, tenantRow.id);

          if (isModuleEnabled(tenant, job.module)) {
            await enqueueJob(tenantRow.id, job.agent);
            log.info(`Enqueued ${job.agent} for ${tenantRow.slug}`);
          }
        }
      } catch (err) {
        log.error(`Scheduler error for ${job.agent}`, err);
      }
    });

    log.info(`  ${job.cron.padEnd(20)} → ${job.agent} (${job.desc})`);
  }

  log.success('Scheduler started');
}

function getSchedule() {
  return SCHEDULE;
}

module.exports = { startScheduler, getSchedule };
