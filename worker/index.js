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
registerAgent('content-generation', require('./agents/content-generation'));
registerAgent('image-generation', require('./agents/image-generation'));
registerAgent('publisher', require('./agents/publisher'));
// registerAgent('speed-to-lead', require('./agents/speed-to-lead'));
// registerAgent('follow-up', require('./agents/follow-up'));
// registerAgent('digest', require('./agents/digest'));
// Future agents registered here as they're ported

// === Health endpoint ===
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'growth-os-worker',
    uptime: Math.floor(process.uptime()),
    lastPoll: getLastPollTime(),
    registeredAgents: Object.keys(require('./jobs/processor')),
    scheduledJobs: getSchedule().length,
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
