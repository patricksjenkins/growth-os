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

const log = createLogger('api');
const app = express();
const PORT = process.env.API_PORT || 3000;

// === Middleware ===
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Rate limiting (per IP for now, per-tenant can be added later)
app.use('/api/', rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  message: { error: 'Too many requests' }
}));

// Static files (generated images)
app.use('/static/images', express.static(path.join(__dirname, '..', 'static', 'images')));

// === Health Check (no auth) ===
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'growth-os-api',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

// === Webhook Routes (their own auth) ===
// TODO: Mount webhook routes here when Twilio/Calendly are configured
// app.use('/webhooks/twilio', require('./webhooks/twilio'));

// === Authenticated API Routes ===
app.use('/api', authMiddleware, tenantMiddleware);

// Mount route modules
app.use('/api/leads', require('./routes/leads'));
app.use('/api/content', require('./routes/content'));
app.use('/api/approvals', require('./routes/approvals'));

// Job status endpoint
app.get('/api/jobs/:id', async (req, res) => {
  try {
    const { db } = require('../db/client');
    const { data, error } = await db
      .from('agent_jobs')
      .select('id, agent_name, status, result, error, created_at, completed_at')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .single();
    if (error || !data) return res.status(404).json({ error: 'Job not found' });
    res.json({ success: true, job: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Dashboard stats
app.get('/api/dashboard', async (req, res) => {
  try {
    const { db } = require('../db/client');
    const tenantId = req.tenantId;

    const [leadsRes, contentRes, jobsRes] = await Promise.all([
      db.from('leads').select('status').eq('tenant_id', tenantId),
      db.from('content_drafts').select('status').eq('tenant_id', tenantId),
      db.from('agent_jobs').select('status').eq('tenant_id', tenantId).gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    ]);

    res.json({
      success: true,
      stats: {
        leads: {
          total: leadsRes.data?.length || 0,
          new: leadsRes.data?.filter(l => l.status === 'new_lead').length || 0
        },
        content: {
          drafts: contentRes.data?.filter(c => c.status === 'draft').length || 0,
          approved: contentRes.data?.filter(c => c.status === 'approved').length || 0,
          posted: contentRes.data?.filter(c => c.status === 'posted').length || 0
        },
        jobs_24h: {
          total: jobsRes.data?.length || 0,
          completed: jobsRes.data?.filter(j => j.status === 'completed').length || 0,
          failed: jobsRes.data?.filter(j => j.status === 'failed').length || 0
        }
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
});

module.exports = app;
