/**
 * Growth OS — API Server
 * Express REST API with auth, tenant isolation, and module-gated routes
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { createLogger } = require('../core/logger');
const { authMiddleware } = require('./middleware/auth');
const { tenantMiddleware } = require('./middleware/tenant');
const { adminMiddleware } = require('./middleware/admin');

const log = createLogger('api');
const app = express();
const PORT = process.env.API_PORT || 3000;

// === Global Middleware ===
app.set('trust proxy', 1); // Trust Railway's reverse proxy for correct client IP
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Rate limiting (per IP)
app.use('/api/', rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  message: { error: 'Too many requests' }
}));

// Static files (generated images) — served at both /static/images and /images
const imagesDir = path.join(__dirname, '..', 'static', 'images');
app.use('/static/images', express.static(imagesDir));
app.use('/images', express.static(imagesDir));

// === Health Check (no auth) ===
app.get('/health', (req, res) => {
  let workerInfo = {};
  try {
    const { getLastPollTime, getRegisteredAgents } = require('../worker/jobs/processor');
    const { getSchedule } = require('../worker/scheduler/cron');
    workerInfo = {
      lastPoll: getLastPollTime(),
      registeredAgents: Object.keys(getRegisteredAgents()).length,
      registeredAgentNames: Object.keys(getRegisteredAgents()),
      scheduledJobs: getSchedule().length
    };
  } catch { /* worker not loaded yet */ }

  res.json({
    status: 'ok',
    service: 'growth-os',
    uptime: Math.floor(process.uptime()),
    worker: workerInfo,
    timestamp: new Date().toISOString()
  });
});

// === Webhook Routes (their own auth — no JWT required) ===
app.use('/webhooks/twilio', require('./webhooks/twilio'));
app.use('/webhooks/calendly', require('./webhooks/calendly'));

// === Admin Routes (cross-tenant, no tenant middleware) ===
app.use('/api/admin', authMiddleware, adminMiddleware, require('./routes/admin'));

// === Tenant Self-View Routes (single-tenant mirror of /api/admin/*) ===
// Every non-platform user hits these. The mobile app routes client_owner /
// tenant_owner / demo users to this base URL for Overview/Pipeline/
// Accounts/Finance screens.
{
  const { tenantOwnerMiddleware, demoWriteGuard } = require('./middleware/tenantOwner');
  app.use(
    '/api/tenant',
    authMiddleware,
    tenantOwnerMiddleware,
    demoWriteGuard,
    require('./routes/tenant'),
  );
}

// === Authenticated API Routes ===
app.use('/api', authMiddleware, tenantMiddleware);

// Core routes
app.use('/api/leads', require('./routes/leads'));
app.use('/api/contacts', require('./routes/contacts'));
app.use('/api/content', require('./routes/content'));
app.use('/api/approvals', require('./routes/approvals'));
app.use('/api/outreach', require('./routes/outreach'));
app.use('/api/finance', require('./routes/finance'));
app.use('/api/crew', require('./routes/crew'));
app.use('/api/jobs', require('./routes/jobs'));
app.use('/api/intelligence', require('./routes/intelligence'));
app.use('/api/notifications', require('./routes/notifications'));

// Dashboard stats + recent items for mobile
app.get('/api/dashboard', async (req, res) => {
  try {
    const { db } = require('../db/client');
    const tenantId = req.tenantId;

    const [leadsRes, contentRes, jobsRes, campaignsRes, pendingRes, recentRes] = await Promise.all([
      db.from('leads').select('status').eq('tenant_id', tenantId),
      db.from('content_drafts').select('status').eq('tenant_id', tenantId),
      db.from('agent_jobs').select('status').eq('tenant_id', tenantId)
        .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()),
      db.from('outreach_campaigns').select('status').eq('tenant_id', tenantId),
      // Recent pending drafts for mobile "Needs Attention" section
      db.from('content_drafts')
        .select('id, headline, platform, created_at')
        .eq('tenant_id', tenantId)
        .eq('status', 'draft')
        .order('created_at', { ascending: false })
        .limit(5),
      // Recent posted/approved for mobile "Recently Posted" section
      db.from('content_drafts')
        .select('id, headline, platform, status')
        .eq('tenant_id', tenantId)
        .in('status', ['posted', 'approved'])
        .order('updated_at', { ascending: false })
        .limit(5),
    ]);

    res.json({
      success: true,
      stats: {
        leads: {
          total: leadsRes.data?.length || 0,
          new: leadsRes.data?.filter(l => l.status === 'new_lead').length || 0,
          won: leadsRes.data?.filter(l => l.status === 'won').length || 0
        },
        content: {
          drafts: contentRes.data?.filter(c => c.status === 'draft').length || 0,
          approved: contentRes.data?.filter(c => c.status === 'approved').length || 0,
          posted: contentRes.data?.filter(c => c.status === 'posted').length || 0
        },
        outreach: {
          active: campaignsRes.data?.filter(c => c.status === 'active').length || 0,
          completed: campaignsRes.data?.filter(c => c.status === 'completed').length || 0
        },
        jobs_24h: {
          total: jobsRes.data?.length || 0,
          completed: jobsRes.data?.filter(j => j.status === 'completed').length || 0,
          failed: jobsRes.data?.filter(j => j.status === 'failed').length || 0
        }
      },
      // Mobile-friendly: actionable items for dashboard cards
      pending_approvals: pendingRes.data || [],
      recent_posts: recentRes.data || [],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Tenant config endpoint (read tenant's own config)
app.get('/api/config', async (req, res) => {
  try {
    const { isModuleEnabled } = require('../core/modules');
    const enabledModules = {};
    for (const [mod, info] of Object.entries(req.tenant.modules || {})) {
      enabledModules[mod] = info.enabled;
    }

    res.json({
      success: true,
      tenant: {
        id: req.tenant.id,
        name: req.tenant.name,
        slug: req.tenant.slug,
        vertical: req.tenant.vertical
      },
      modules: enabledModules,
      config: {
        business_name: req.tenant.config?.business_name,
        brand_colors: req.tenant.config?.brand_colors,
        timezone: req.tenant.config?.timezone,
        status_flow: req.tenant.config?.status_flow
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === Error Handler ===
app.use((err, req, res, next) => {
  log.error('Unhandled error', err);
  res.status(err.statusCode || 500).json({
    error: err.message || 'Internal server error'
  });
});

// === Start ===
app.listen(PORT, () => {
  log.success(`API server running on port ${PORT}`);

  // Boot the worker (scheduler + job processor) in the same process
  try {
    const { startScheduler } = require('../worker/scheduler/cron');
    const { startJobProcessor, registerAgent } = require('../worker/jobs/processor');

    // Register all agents — each in its own try/catch so one failure doesn't skip the rest
    const agentDefs = [
      // Content Pipeline
      ['content-generation', '../worker/agents/content-generation'],
      ['image-generation', '../worker/agents/image-generation'],
      ['publisher', '../worker/agents/publisher'],
      ['campaign-orchestrator', '../worker/agents/campaign-orchestrator'],
      ['distribution', '../worker/agents/distribution'],
      // 'schedule' agent retired — Buffer's queue handles post timing
      ['approval-queue', '../worker/agents/approval-queue'],
      // Communication
      ['speed-to-lead', '../worker/agents/speed-to-lead'],
      ['follow-up', '../worker/agents/follow-up'],
      ['missed-call', '../worker/agents/missed-call'],
      ['review-request', '../worker/agents/review-request'],
      ['referral-request', '../worker/agents/referral-request'],
      ['outreach', '../worker/agents/outreach'],
      ['reply-classification', '../worker/agents/reply-classification'],
      // Intelligence
      ['prospecting', '../worker/agents/prospecting'],
      ['enrichment', '../worker/agents/enrichment'],
      ['scoring', '../worker/agents/scoring'],
      ['chief-of-staff', '../worker/agents/chief-of-staff'],
      ['meeting-prep', '../worker/agents/meeting-prep'],
      ['advertising', '../worker/agents/advertising'],
      ['clients-manager', '../worker/agents/clients-manager'],
      ['digest', '../worker/agents/digest'],
      // Social & Engagement
      ['social-engagement', '../worker/agents/social-content-agent'],
      // Notifications
      ['notification-push', '../worker/agents/notification-push'],
      ['notifications', '../worker/agents/notifications'],
      // Back-Office & Financial Operations
      ['billing', '../worker/agents/billing'],
      ['bookkeeping', '../worker/agents/bookkeeping'],
      ['financial-dashboard', '../worker/agents/financial-dashboard'],
      ['tax-prep', '../worker/agents/tax-prep'],
      ['account-management', '../worker/agents/account-management'],
      ['client-health', '../worker/agents/client-health'],
      ['reporting', '../worker/agents/reporting'],
      // Onboarding & Platform — these agents were enqueued by the scheduler
      // but never registered here, producing "Unknown agent" failures in
      // agent_jobs (surfaced by platform-daily-digest). NOTE: this file is
      // the runtime agent registry — worker/index.js is NOT loaded by the
      // Railway deploy, only api/server.js is. Any new agent MUST be added
      // here to actually run in production.
      ['onboarding-advance', '../worker/agents/onboarding-advance'],
      ['scheduled-email-dispatch', '../worker/agents/scheduled-email-dispatch'],
      ['platform-daily-digest', '../worker/agents/platform-daily-digest'],
    ];

    let registered = 0;
    for (const [name, modulePath] of agentDefs) {
      try {
        registerAgent(name, require(modulePath));
        registered++;
      } catch (err) {
        log.error(`Failed to register agent "${name}": ${err.message}`);
      }
    }
    log.success(`Registered ${registered}/${agentDefs.length} agents`);

    startScheduler();
    startJobProcessor();
    log.success('Worker started (scheduler + job processor)');
  } catch (err) {
    log.error('Worker failed to start — API still running', err);
  }
});

module.exports = app;
