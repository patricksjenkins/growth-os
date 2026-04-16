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

    // Register all 32 agents
    // Content Pipeline
    registerAgent('content-generation', require('../worker/agents/content-generation'));
    registerAgent('image-generation', require('../worker/agents/image-generation'));
    registerAgent('publisher', require('../worker/agents/publisher'));
    registerAgent('campaign-orchestrator', require('../worker/agents/campaign-orchestrator'));
    registerAgent('distribution', require('../worker/agents/distribution'));
    registerAgent('schedule', require('../worker/agents/schedule'));
    registerAgent('approval-queue', require('../worker/agents/approval-queue'));

    // Communication
    registerAgent('speed-to-lead', require('../worker/agents/speed-to-lead'));
    registerAgent('follow-up', require('../worker/agents/follow-up'));
    registerAgent('missed-call', require('../worker/agents/missed-call'));
    registerAgent('review-request', require('../worker/agents/review-request'));
    registerAgent('referral-request', require('../worker/agents/referral-request'));
    registerAgent('outreach', require('../worker/agents/outreach'));
    registerAgent('reply-classification', require('../worker/agents/reply-classification'));

    // Intelligence
    registerAgent('prospecting', require('../worker/agents/prospecting'));
    registerAgent('enrichment', require('../worker/agents/enrichment'));
    registerAgent('scoring', require('../worker/agents/scoring'));
    registerAgent('chief-of-staff', require('../worker/agents/chief-of-staff'));
    registerAgent('meeting-prep', require('../worker/agents/meeting-prep'));
    registerAgent('advertising', require('../worker/agents/advertising'));
    registerAgent('clients-manager', require('../worker/agents/clients-manager'));
    registerAgent('digest', require('../worker/agents/digest'));

    // Social & Engagement
    registerAgent('social-engagement', require('../worker/agents/social-content-agent'));

    // Notifications
    registerAgent('notification-push', require('../worker/agents/notification-push'));
    registerAgent('notifications', require('../worker/agents/notifications'));

    // Back-Office & Financial Operations
    registerAgent('billing', require('../worker/agents/billing'));
    registerAgent('bookkeeping', require('../worker/agents/bookkeeping'));
    registerAgent('financial-dashboard', require('../worker/agents/financial-dashboard'));
    registerAgent('tax-prep', require('../worker/agents/tax-prep'));
    registerAgent('account-management', require('../worker/agents/account-management'));
    registerAgent('client-health', require('../worker/agents/client-health'));
    registerAgent('reporting', require('../worker/agents/reporting'));

    startScheduler();
    startJobProcessor();
    log.success('Worker started (scheduler + job processor)');
  } catch (err) {
    log.error('Worker failed to start — API still running', err);
  }
});

module.exports = app;
