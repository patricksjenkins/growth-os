/**
 * Growth OS — API Server
 * Express REST API with auth, tenant isolation, and module-gated routes
 */

require('dotenv').config();
// Sentry MUST be initialized before express + route imports so the SDK's
// auto-instrumentation can wrap http/fs/etc. No-ops cleanly if SENTRY_DSN
// is unset, so dev environments without the env var aren't impacted.
const { initSentry, attachExpressErrorHandler } = require('../core/sentry');
initSentry();

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

// CORS — allow only known origins in production; allow all if ALLOWED_ORIGINS not set (dev)
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const globalCors = cors(allowedOrigins.length ? {
  origin: (origin, cb) => {
    // Allow requests without Origin (mobile apps, curl, server-to-server)
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    // Also allow vercel preview subdomains matching configured root
    if (allowedOrigins.some(o => o.startsWith('*.') && origin.endsWith(o.slice(1)))) return cb(null, true);
    return cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
} : {});
// Public, embeddable endpoints that customer websites call directly from
// the browser on their OWN domains (akutabovetreeservices.com, etc.). These
// must work from arbitrary customer origins, carry no auth cookies, and are
// each individually protected, so permissive CORS is safe here:
//   - /api/design        — AI Design Studio (email-gated, monthly-capped)
//   - /api/leads/capture — DFY/customer-site contact forms (no-auth,
//                          per-IP rate-limited, per-tenant daily-capped,
//                          tenant validated; lead scoped to its tenant_id)
//   - /api/chat          — embeddable AI chat widget (widget-token verified
//                          per tenant, rate-limited)
// Everything else (admin + authenticated routes) keeps the strict allowlist.
const designCors = cors({ origin: true });
function isPublicEmbeddablePath(p) {
  return p.startsWith('/api/design')
    || p === '/api/leads/capture'
    || p.startsWith('/api/chat');
}
app.use((req, res, next) =>
  isPublicEmbeddablePath(req.path) ? designCors(req, res, next) : globalCors(req, res, next));

// Stripe webhook must be mounted BEFORE express.json() so it sees the raw body
// for signature verification. Mount here with express.raw() so the body is a Buffer.
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['stripe-signature'];
  if (!signature) {
    log.warn('Stripe webhook received without Stripe-Signature header');
    return res.status(400).json({ error: 'Missing Stripe-Signature header' });
  }
  try {
    const { handleWebhook } = require('../integrations/stripe');
    const result = await handleWebhook(req.body, signature);
    log.info(`Stripe webhook processed: ${result.action}`);
    res.json({ received: true, result });
  } catch (err) {
    log.error(`Stripe webhook failed: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

// Capture the raw body on every JSON request so webhooks that need byte-exact
// payloads for signature verification (Telnyx Ed25519) can access req.rawBody.
app.use(express.json({ limit: '10mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

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

// Chat widget script — served at /chat/widget.js for DFY websites to embed
const staticDir = path.join(__dirname, '..', 'static');
app.use('/chat/widget.js', express.static(path.join(staticDir, 'chat-widget.js'), {
  maxAge: '1h',
  setHeaders: (res) => { res.setHeader('Content-Type', 'application/javascript'); },
}));

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
      scheduledJobs: getSchedule().length,
      schedulerEnabled: process.env.SCHEDULER_ENABLED !== 'false',
      processorEnabled: process.env.JOB_PROCESSOR_ENABLED !== 'false',
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
app.use('/webhooks/telnyx', require('./webhooks/telnyx'));
app.use('/webhooks/calendly', require('./webhooks/calendly'));
app.use('/webhooks/voice-receptionist', require('./webhooks/voice-receptionist'));

// === Public Routes (no auth — anonymous visitors on marketing site) ===
// /api/chat backs the floating chat widget on firstgenautomate.com.
// It rate-limits itself internally on top of the app-wide /api/ limiter.
app.use('/api/chat', require('./routes/chat'));
// /api/onboarding/intake accepts the multipart onboarding form from
// firstgenautomate.com/onboarding — public so prospects can submit before
// any tenant auth is provisioned. Creates/updates the tenant row.
app.use('/api/onboarding', require('./routes/onboarding'));
// /api/leads/capture accepts public form submissions from customer-facing
// DFY websites (each customer site embeds a form with their tenant_id).
// Must be mounted BEFORE the /api authMiddleware below, otherwise the
// auth-required /api/leads router at line ~143 swallows /capture too and
// returns 401. Tenant attribution flows via the required tenant_id field
// in the request body. Speed-to-lead is auto-enqueued on success so the
// prospect gets the promised <60-second text response.
app.use('/api/leads', require('./routes/leads-capture'));
// /api/drip/unsubscribe — public unsubscribe link + RFC 8058 one-click
// (List-Unsubscribe-Post) target for drip-campaign emails. Token-gated
// (HMAC) inside the route, so no auth middleware here.
app.use('/api/drip', require('./routes/drip-public'));

// === Admin Routes (cross-tenant, no tenant middleware) ===
app.use('/api/admin', authMiddleware, adminMiddleware, require('./routes/admin'));
// Platform-owner Module Promo Generator. Mounted as a sub-path so it
// reuses the same adminMiddleware gate, but the routes live in their
// own file to keep the admin.js core lean.
app.use('/api/admin/marketing', authMiddleware, adminMiddleware, require('./routes/admin-marketing'));
// Internal Expense Tracker — FGA-internal only (NOT a customer feature).
// Upload receipt/invoice -> OCR -> pending draft -> review -> approve/reject.
app.use('/api/admin/expenses', authMiddleware, adminMiddleware, require('./routes/admin-expenses'));
// Agent Hub — platform-owner operational view of dependency probes + per-agent
// run health + output collapse. Surfaces the silent failures the daily digest
// missed (e.g. out-of-credits Serper key stalling lead-gen).
app.use('/api/admin/agent-hub', authMiddleware, adminMiddleware, require('./routes/admin-agent-hub'));
// Drip Campaign Control Center — campaign generation/approval, enrollments,
// review queue, migration, coupons reporting, Gmail connect. FGA-internal.
app.use('/api/admin/drip', authMiddleware, adminMiddleware, require('./routes/admin-drip'));
// AI Safety dashboard + manual kill-switch/breaker/batch controls. Read-only
// overview is monitor-data; switch controls only affect live traffic when an
// enforcement flag is enabled (all default OFF). Platform-owner only.
app.use('/api/admin/ai-safety', authMiddleware, adminMiddleware, require('./routes/admin-ai-safety'));
// Targeted Campaigns — owner-defined targeted prospecting campaigns with
// pilot/approval gates, hard goals, budget caps, and kill switches. The
// agent stays idle unless a campaign is in an executable status.
app.use('/api/admin/targeted-campaigns', authMiddleware, adminMiddleware, require('./routes/admin-targeted-campaigns'));
// Video stream proxy — mounted SEPARATELY (no header-based auth gate)
// because <video> elements and direct-download links can't send a
// Bearer token in headers. The route does its own inline JWT check
// against the ?token= query param and validates platform-owner role.
// Hides the GOOGLE_API_KEY from the browser by fetching Veo's Files
// API server-side and streaming the bytes back.
app.use('/api/admin-marketing-stream', require('./routes/admin-marketing-stream'));

// CPA read-only API — mounted BEFORE the global auth middleware because
// it has its own bearer-token auth (X-FGA-CPA-Token header). External
// CPA accounting tools use this to pull the year-end report bundle.
app.use('/api/cpa', require('./routes/cpa-readonly'));

// Public AI Design Studio (923A Coins) — customer-facing concept generator.
// Mounted BEFORE the global auth middleware; email-gated + monthly-capped in
// the route itself so it's safe to expose publicly.
app.use('/api/design', require('./routes/design'));

// === Tenant Self-View Routes (single-tenant mirror of /api/admin/*) ===
// Every non-platform user hits these. The mobile app routes client_owner /
// tenant_owner / demo users to this base URL for Overview/Pipeline/
// Accounts/Finance screens.
{
  const { tenantOwnerMiddleware, demoWriteGuard } = require('./middleware/tenantOwner');
  const crossTenantTripwire = require('./middleware/cross-tenant-tripwire');
  app.use(
    '/api/tenant',
    authMiddleware,
    tenantOwnerMiddleware,
    demoWriteGuard,
    crossTenantTripwire,
    require('./routes/tenant'),
  );
}

// === Authenticated API Routes ===
app.use('/api', authMiddleware, tenantMiddleware);

// Cross-tenant tripwire — defense-in-depth. Wraps res.json on every
// /api/* route mounted BELOW this line so any response containing a
// tenant_id that doesn't match the caller's req.tenantId is logged
// (Sentry-loud) and replaced with a generic error. After Phase C
// (RLS-keyed policies + user-JWT clients on every tenant-scoped
// route) this should be structurally impossible; the tripwire exists
// to catch regressions. /api/admin/* is mounted above and is
// unaffected.
app.use('/api', require('./middleware/cross-tenant-tripwire'));

// Core routes
app.use('/api/leads', require('./routes/leads'));
app.use('/api/contacts', require('./routes/contacts'));
app.use('/api/content', require('./routes/content'));
app.use('/api/approvals', require('./routes/approvals'));
app.use('/api/outreach', require('./routes/outreach'));
app.use('/api/finance', require('./routes/finance'));
// Phase 1 Step 7 — Command Center unified attention queue. Read endpoints
// feed the Action Ribbon, Reconciliation Queue, Mobile Inbox + drill-downs.
app.use('/api/attention', require('./routes/attention'));
// Phase 3 — Growth & Ops metrics. Live-computed (no period locks apply).
// MRR trend, churn, LTV/CAC, runway, automation health, time-to-value.
app.use('/api/metrics', require('./routes/metrics'));
app.use('/api/crew', require('./routes/crew'));
app.use('/api/jobs', require('./routes/jobs'));
app.use('/api/intelligence', require('./routes/intelligence'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/referrals', require('./routes/referrals'));
app.use('/api/voice', require('./routes/voice'));

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

// === Sentry Express error handler ===
// Captures unhandled errors from any registered route BEFORE our custom
// JSON error responder runs. No-op if Sentry isn't initialized.
attachExpressErrorHandler(app);

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

  // V1 hardening (2026-05-24): subscribe to Supabase Realtime so any
  // tenant config / module / integration change evicts every dyno's
  // in-memory cache within ~1 second. Without this, multi-dyno deploys
  // serve stale config for up to CACHE_TTL (5 min) after Patrick toggles
  // a module. Requires migration 035 + Realtime publication on
  // tenants/tenant_config/tenant_modules/tenant_integrations.
  try {
    const { getServiceClient } = require('../db/client');
    const { subscribeToTenantInvalidations } = require('../core/tenant');
    subscribeToTenantInvalidations(getServiceClient());
  } catch (err) {
    log.warn(`Could not start tenant-cache Realtime subscription: ${err.message}`);
  }

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
      ['past-customer-reengagement', '../worker/agents/past-customer-reengagement'],
      ['sales-nurture', '../worker/agents/sales-nurture'],
      ['missed-call', '../worker/agents/missed-call'],
      ['review-request', '../worker/agents/review-request'],
      ['referral-request', '../worker/agents/referral-request'],
      ['partner-outreach', '../worker/agents/partner-outreach'],
      ['outreach', '../worker/agents/outreach'],
      ['reply-classification', '../worker/agents/reply-classification'],
      ['conversation-responder', '../worker/agents/conversation-responder'],
      // Intelligence
      ['prospecting', '../worker/agents/prospecting'],
      ['enrichment', '../worker/agents/enrichment'],
      // facebook-prospecting (2026-05-26): picks up where enrichment
      // leaves off for fb_only leads. Two-touch SMS + manual FB DM draft.
      // Cron runs daily 2pm ET; monthly mode re-enriches the bucket.
      ['facebook-prospecting', '../worker/agents/facebook-prospecting'],
      // targeted-campaign (2026-06-11): owner-defined targeted campaigns.
      // Idle by default — the scheduler `when` predicate only enqueues it
      // when a campaign is in an executable status. Fully separate from
      // the standard prospecting agent.
      ['targeted-campaign', '../worker/agents/targeted-campaign'],
      ['scoring', '../worker/agents/scoring'],
      ['chief-of-staff', '../worker/agents/chief-of-staff'],
      ['meeting-prep', '../worker/agents/meeting-prep'],
      ['advertising', '../worker/agents/advertising'],
      ['clients-manager', '../worker/agents/clients-manager'],
      ['digest', '../worker/agents/digest'],
      // Voice (Module 9 — replaces retired social-engagement stub)
      ['voice-receptionist', '../worker/agents/voice-receptionist'],
      // Notifications
      ['notification-push', '../worker/agents/notification-push'],
      ['notifications', '../worker/agents/notifications'],
      // Back-Office & Financial Operations
      ['billing', '../worker/agents/billing'],
      ['bookkeeping', '../worker/agents/bookkeeping'],
      ['financial-dashboard', '../worker/agents/financial-dashboard'],
      ['tax-prep', '../worker/agents/tax-prep'],
      // BI & Financial Sync stretch enhancements (§8 + §10)
      ['audit-dry-run', '../worker/agents/audit-dry-run'],
      ['nexus-monitor', '../worker/agents/nexus-monitor'],
      ['churn-risk-detector', '../worker/agents/churn-risk-detector'],
      ['threshold-alerts', '../worker/agents/threshold-alerts'],
      ['mercury-sync', '../worker/agents/mercury-sync'],
      ['inbound-sms-responder', '../worker/agents/inbound-sms-responder'],
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
      // Actively probes every external dependency (Serper/Anthropic/Gemini/
      // Telnyx/Buffer) + platform services, persists to platform_health_checks,
      // and CRITICAL-alerts on any outage. Closes the silent-failure gap that
      // let lead-gen stall for ~2 weeks on an out-of-credits Serper key.
      ['system-monitor', '../worker/agents/system-monitor'],
      ['app-asset-pipeline', '../worker/agents/app-asset-pipeline'],
      ['dfy-website-build', '../worker/agents/dfy-website-build'],
      ['monthly-usage-reset', '../worker/agents/monthly-usage-reset'],
      // Drip campaign (FGA-only — agent guards tenant.id internally).
      // Two cron modes: default 'process_sends' + payload.task 'sync_replies'.
      ['drip-campaign', '../worker/agents/drip-campaign'],
      // V1 hardening (2026-05-24): publisher was registered twice — once
      // in the Content Pipeline group (line ~304) and again here. The
      // registerAgent map dedupes by key so it was harmless at runtime,
      // but confused external audits (Codex flagged it). Single source
      // now lives in Content Pipeline above.
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

    // Two-service deploy guard: Railway runs both a `growth-os` service
    // and a `worker` service, both of which load this file. Without this
    // gate the scheduler fires twice (once per service) and the job
    // processor races — producing duplicate digest emails and duplicate
    // content generations (seen in production 2026-04-21).
    //
    // Rule:
    //   SCHEDULER_ENABLED / JOB_PROCESSOR_ENABLED default to true if unset
    //   so a single-service deploy still works out of the box. To eliminate
    //   the duplicates set SCHEDULER_ENABLED=false and
    //   JOB_PROCESSOR_ENABLED=false on the SECONDARY service. Set both to
    //   true (or leave unset) on the primary.
    const schedulerEnabled = process.env.SCHEDULER_ENABLED !== 'false';
    const processorEnabled = process.env.JOB_PROCESSOR_ENABLED !== 'false';

    if (schedulerEnabled) {
      startScheduler();
      log.success('Scheduler started');
    } else {
      log.warn('SCHEDULER_ENABLED=false — scheduler NOT started in this process');
    }

    if (processorEnabled) {
      startJobProcessor();
      log.success('Job processor started');
    } else {
      log.warn('JOB_PROCESSOR_ENABLED=false — job processor NOT started in this process');
    }
  } catch (err) {
    log.error('Worker failed to start — API still running', err);
  }
});

module.exports = app;
