/**
 * Growth OS — Job Processor
 * Polls agent_jobs table, dispatches to agent modules
 */

const { createLogger } = require('../../core/logger');
const { resolveTenant } = require('../../core/tenant');
const { getServiceClient } = require('../../db/client');
const { getPendingJobs, markProcessing, markCompleted, markFailed, logActivity } = require('../../db/queries/jobs');
const { runWithAgentContext } = require('../../core/agent-context');
const { buildOutcomeEnvelope } = require('../../core/autonomous-os/outcome-contract');
const { recordJobOutcome } = require('../../core/autonomous-os/outcome-recorder');

const log = createLogger('processor');

// Agent registry — maps agent names to their handler functions
const agents = {};

function registerAgent(name, handler) {
  agents[name] = handler;
}

/**
 * Run a single agent
 */
async function runAgent(agentName, tenantId, payload) {
  const handler = agents[agentName];
  if (!handler) {
    throw new Error(`Unknown agent: ${agentName}`);
  }

  const supabase = getServiceClient();
  const tenant = await resolveTenant(supabase, tenantId);

  // Tag every AI call this agent makes with its agent name + tenant for usage
  // attribution (see core/agent-context.js).
  return await runWithAgentContext({ agentName, tenantId }, () => handler(tenant, payload));
}

/**
 * Poll for pending jobs and process them
 */
let lastPollTime = null;

async function pollJobs() {
  try {
    const jobs = await getPendingJobs(3);
    lastPollTime = new Date().toISOString();

    for (const job of jobs) {
      const startTime = Date.now();

      try {
        const claimed = await markProcessing(job.id);
        if (!claimed) {
          log.info(`Skipped already-claimed job: ${job.id}`);
          continue;
        }
        log.info(`Processing: ${job.agent_name} for tenant ${job.tenant_id}`);

        const result = await runAgent(job.agent_name, job.tenant_id, job.payload);
        const outcome = buildOutcomeEnvelope({
          result,
          durationMs: Date.now() - startTime,
        });

        await markCompleted(job.id, result);
        await recordJobOutcome({
          jobId: job.id,
          tenantId: job.tenant_id,
          agentName: job.agent_name,
          envelope: outcome,
        });
        await logActivity(job.tenant_id, job.agent_name, 'job_completed', {
          _startTime: startTime,
          status: 'success',
          data: {
            job_id: job.id,
            outcome_contract: outcome,
          }
        });

        log.success(`Completed: ${job.agent_name} (${Date.now() - startTime}ms)`);
      } catch (err) {
        const outcome = buildOutcomeEnvelope({
          error: err,
          durationMs: Date.now() - startTime,
        });
        await markFailed(job.id, err.message);
        await recordJobOutcome({
          jobId: job.id,
          tenantId: job.tenant_id,
          agentName: job.agent_name,
          envelope: outcome,
        });
        await logActivity(job.tenant_id, job.agent_name, 'job_failed', {
          _startTime: startTime,
          status: 'failed',
          error: err.message,
          data: {
            job_id: job.id,
            outcome_contract: outcome,
          }
        });

        log.error(`Failed: ${job.agent_name}`, err);
      }
    }
  } catch (err) {
    log.error('Poll cycle failed', err);
  }
}

/**
 * Start the job processor polling loop
 */
function startJobProcessor() {
  log.info('Job processor started (polling every 10s)');
  setInterval(pollJobs, 10_000);
  // Run once immediately
  pollJobs();
}

function getLastPollTime() {
  return lastPollTime;
}

function getRegisteredAgents() {
  return agents;
}

module.exports = { startJobProcessor, registerAgent, runAgent, getLastPollTime, getRegisteredAgents };
