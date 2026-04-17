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

// === Register all agents (32 total) ===

// Content Pipeline
registerAgent('content-generation', require('./agents/content-generation'));
registerAgent('image-generation', require('./agents/image-generation'));
registerAgent('publisher', require('./agents/publisher'));
registerAgent('campaign-orchestrator', require('./agents/campaign-orchestrator'));
registerAgent('distribution', require('./agents/distribution'));
registerAgent('schedule', require('./agents/schedule'));
registerAgent('approval-queue', require('./agents/approval-queue'));

// Communication Agents
registerAgent('speed-to-lead', require('./agents/speed-to-lead'));
registerAgent('follow-up', require('./agents/follow-up'));
registerAgent('missed-call', require('./agents/missed-call'));
registerAgent('review-request', require('./agents/review-request'));
registerAgent('referral-request', require('./agents/referral-request'));
registerAgent('outreach', require('./agents/outreach'));
registerAgent('reply-classification', require('./agents/reply-classification'));

// Intelligence Agents
registerAgent('prospecting', require('./agents/prospecting'));
registerAgent('enrichment', require('./agents/enrichment'));
registerAgent('scoring', require('./agents/scoring'));
registerAgent('chief-of-staff', require('./agents/chief-of-staff'));
registerAgent('meeting-prep', require('./agents/meeting-prep'));
registerAgent('advertising', require('./agents/advertising'));
registerAgent('clients-manager', require('./agents/clients-manager'));
registerAgent('digest', require('./agents/digest'));

// Social & Engagement
registerAgent('social-engagement', require('./agents/social-engagement'));

// Notifications
registerAgent('notification-push', require('./agents/notification-push'));
registerAgent('notifications', require('./agents/notifications'));

// Onboarding & Platform
registerAgent('onboarding-advance', require('./agents/onboarding-advance'));
registerAgent('scheduled-email-dispatch', require('./agents/scheduled-email-dispatch'));

// Back-Office & Financial Operations
registerAgent('billing', require('./agents/billing'));
registerAgent('bookkeeping', require('./agents/bookkeeping'));
registerAgent('financial-dashboard', require('./agents/financial-dashboard'));
registerAgent('tax-prep', require('./agents/tax-prep'));
registerAgent('account-management', require('./agents/account-management'));
registerAgent('client-health', require('./agents/client-health'));
registerAgent('reporting', require('./agents/reporting'));

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
