/**
 * Growth OS — Intelligence & Analytics Routes
 * Exposes scoring, enrichment, lifecycle, and analytics endpoints.
 */

const express = require('express');
const router = express.Router();
const leadsDb = require('../../db/queries/leads');
const { db } = require('../../db/client');
const { enqueueJob } = require('../../db/queries/jobs');

// ============================================================================
// ANALYTICS
// ============================================================================

/**
 * GET /api/intelligence/stats
 * Full intelligence dashboard stats
 */
router.get('/stats', async (req, res) => {
  try {
    const stats = await leadsDb.getIntelligenceStats(req.tenantId);
    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/intelligence/pipeline
 * Lifecycle funnel: prospect → enriched → scored → sequenced → meeting_booked → won/lost
 */
router.get('/pipeline', async (req, res) => {
  try {
    const stats = await leadsDb.getIntelligenceStats(req.tenantId);

    const funnel = [
      { stage: 'prospect', count: stats.by_lifecycle.prospect || 0 },
      { stage: 'enriched', count: stats.by_lifecycle.enriched || 0 },
      { stage: 'scored', count: stats.by_lifecycle.scored || 0 },
      { stage: 'sequenced', count: stats.by_lifecycle.sequenced || 0 },
      { stage: 'meeting_booked', count: stats.by_lifecycle.meeting_booked || 0 },
      { stage: 'won', count: stats.by_lifecycle.won || 0 },
      { stage: 'lost', count: stats.by_lifecycle.lost || 0 }
    ];

    res.json({ success: true, funnel, total: stats.total });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// LEAD INTELLIGENCE VIEWS
// ============================================================================

/**
 * GET /api/intelligence/outreach-ready
 * Leads ready for outreach (Tier A, scored, outreach_ready=true)
 */
router.get('/outreach-ready', async (req, res) => {
  try {
    const leads = await leadsDb.getOutreachReady(req.tenantId);
    res.json({ success: true, leads, count: leads.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/intelligence/lifecycle/:stage
 * Leads in a specific lifecycle stage
 */
router.get('/lifecycle/:stage', async (req, res) => {
  try {
    const leads = await leadsDb.getLeadsByLifecycle(req.tenantId, req.params.stage);
    res.json({ success: true, leads, count: leads.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// AGENT TRIGGERS (manual runs)
// ============================================================================

/**
 * POST /api/intelligence/run/scoring
 * Manually trigger a scoring run
 */
router.post('/run/scoring', async (req, res) => {
  try {
    const job = await enqueueJob(req.tenantId, 'scoring', {
      limit: req.body.limit || 25
    }, { priority: 5 });
    res.json({ success: true, message: 'Scoring job enqueued', job_id: job.id });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/intelligence/run/prospecting
 * Manually trigger a prospecting run
 */
router.post('/run/prospecting', async (req, res) => {
  try {
    const job = await enqueueJob(req.tenantId, 'prospecting', {
      limit: req.body.limit || 25
    }, { priority: 5 });
    res.json({ success: true, message: 'Prospecting job enqueued', job_id: job.id });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/intelligence/run/enrichment
 * Manually trigger enrichment (optionally for a specific lead)
 */
router.post('/run/enrichment', async (req, res) => {
  try {
    const job = await enqueueJob(req.tenantId, 'enrichment', {
      limit: req.body.limit || 10,
      lead_id: req.body.lead_id || null
    }, { priority: 5 });
    res.json({ success: true, message: 'Enrichment job enqueued', job_id: job.id });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/intelligence/run/digest
 * Manually trigger a digest
 */
router.post('/run/digest', async (req, res) => {
  try {
    const job = await enqueueJob(req.tenantId, 'digest', {
      deliver: req.body.deliver || 'log'
    }, { priority: 3 });
    res.json({ success: true, message: 'Digest job enqueued', job_id: job.id });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/intelligence/briefing
 * Get a live chief-of-staff briefing (runs inline, not via job queue)
 */
router.get('/briefing', async (req, res) => {
  try {
    const chiefOfStaff = require('../../worker/agents/chief-of-staff');
    const { resolveTenant } = require('../../core/tenant');
    const { getServiceClient } = require('../../db/client');

    const tenant = await resolveTenant(getServiceClient(), req.tenantId);
    const result = await chiefOfStaff(tenant, { type: req.query.type || 'briefing' });

    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// AGENT ACTIVITY LOG
// ============================================================================

/**
 * GET /api/intelligence/activity
 * Recent agent activity for this tenant
 */
router.get('/activity', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const { data, error } = await db
      .from('agent_activity_log')
      .select('*')
      .eq('tenant_id', req.tenantId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    res.json({ success: true, activity: data || [], count: (data || []).length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
