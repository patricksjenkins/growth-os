/**
 * Growth OS — Worker Service
 * Runs scheduled agents and processes job queue
 */

require('dotenv').config();
const express = require('express');
const { createLogger } = require('../core/logger');
const { startScheduler, getSchedule } = require('./scheduler/cron');
const { startJobProcessor, registerAgent, getLastPollTime } = require('./jobs/processor');

const log = createLogger('worker');
const app = express();
const PORT = process.env.WORKER_PORT || 3001;

// === Register all agents ===
// Phase 3B: Content Pipeline
registerAgent('content-generation', require('./agents/content-generation'));
registerAgent('image-generation', require('./agents/image-generation'));
registerAgent('publisher', require('./agents/publisher'));

// Phase 3C: Communication Agents
registerAgent('speed-to-lead', require('./agents/speed-to-lead'));
registerAgent('follow-up', require('./agents/follow-up'));
registerAgent('missed-call', require('./agents/missed-call'));
registerAgent('review-request', require('./agents/review-request'));
registerAgent('referral-request', require('./agents/referral-request'));

// Phase 3D: Intelligence Agents
registerAgent('prospecting', require('./agents/prospecting'));
registerAgent('enrichment', require('./agents/enrichment'));
registerAgent('scoring', require('./agents/scoring'));
registerAgent('chief-of-staff', require('./agents/chief-of-staff'));
registerAgent('digest', require('./agents/digest'));
// registerAgent('outreach-drip', require('./agents/outreach-drip'));        // Phase 3D.2
// registerAgent('reply-classification', require('./agents/reply-classification')); // Phase 3D.2
// registerAgent('meeting-prep', require('./agents/meeting-prep'));          // Phase 3D.2

// === Health endpoint ===
app.get('/health', (req, res) => {
  const schedule = getSchedule();

  res.json({
    status: 'ok',
    service: 'growth-os-worker',
    uptime: Math.floor(process.uptime()),
    lastPoll: getLastPollTime(),
    registeredAgents: Object.keys(require('./jobs/processor').getRegisteredAgents()),
    scheduledJobs: schedule.length,
    schedule: schedule.map(j => ({ agent: j.agent, cron: j.cron, module: j.module })),
    timestamp: new Date().toISOString()
  });
});

// === Start everything ===
app.listen(PORT, () => {
  log.success(`Worker health endpoint on port ${PORT}`);
});

startScheduler();
startJobProcessor();

log.success('Worker service running');
