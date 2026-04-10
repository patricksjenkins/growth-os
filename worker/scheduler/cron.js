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
  { agent: 'speed-to-lead',      cron: '*/2 * * * *',    module: 'speed_to_lead',     desc: 'Catch new leads' },
  { agent: 'follow-up',          cron: '0 8-18 * * 1-5', module: 'follow_up',         desc: 'SMS follow-up sequences' },
  { agent: 'prospecting',        cron: '0 6 * * 1-5',    module: 'prospecting',       desc: 'Find new prospects' },
  { agent: 'enrichment',         cron: '0 7 * * 1-5',    module: 'prospecting',       desc: 'Enrich prospect data' },
  { agent: 'scoring',            cron: '30 7 * * 1-5',   module: 'lead_scoring',      desc: 'Score leads' },
  { agent: 'outreach-drip',      cron: '0 9 * * 1,4',    module: 'outreach_drip',     desc: 'Email drip campaigns' },
  { agent: 'review-request',     cron: '0 10 * * *',     module: 'review_request',    desc: 'Post-job review asks' },
  { agent: 'content-generation', cron: '0 11 * * 1',     module: 'content_engine',    desc: 'Weekly content batch' },
  { agent: 'publisher',          cron: '0 9 * * 1-5',    module: 'publishing',        desc: 'Publish approved content' },
  { agent: 'referral-request',   cron: '0 14 * * *',     module: 'referral_request',  desc: 'Post-job referral asks' },
  { agent: 'digest',             cron: '0 17 * * 1-5',   module: 'digest',            desc: 'End-of-day summary' },
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
