/**
 * Growth OS — Agent Jobs Routes
 * View job status and trigger manual agent runs
 */

const express = require('express');
const router = express.Router();
const { db } = require('../../db/client');
const { enqueueJob } = require('../../db/queries/jobs');
const { isModuleEnabled } = require('../../core/modules');
const { validateId } = require('../middleware/validate');

// List recent jobs
router.get('/', async (req, res) => {
  try {
    let query = db
      .from('agent_jobs')
      .select('id, agent_name, status, error, created_at, completed_at')
      .eq('tenant_id', req.tenantId)
      .order('created_at', { ascending: false });

    if (req.query.status) query = query.eq('status', req.query.status);
    if (req.query.agent) query = query.eq('agent_name', req.query.agent);
    query = query.limit(parseInt(req.query.limit) || 50);

    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, jobs: data, count: data.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get single job with result
router.get('/:id', validateId(), async (req, res) => {
  try {
    const { data, error } = await db
      .from('agent_jobs')
      .select('*')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .single();
    if (error || !data) return res.status(404).json({ success: false, error: 'Job not found' });
    res.json({ success: true, job: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Manually trigger an agent run.
//
// V1 hardening (2026-05-24): user-triggerable agents are now an explicit
// allowlist. Cron-only agents (prospecting, mercury-sync, monthly-usage-reset,
// platform-daily-digest, audit-dry-run, tax-prep, etc.) are blocked here —
// they're meant to fire on schedule against scoped tenant state, not on
// arbitrary user input. Agents that legitimately accept manual triggers from
// the mobile/web UI go in TRIGGERABLE_AGENTS below.
const TRIGGERABLE_AGENTS = new Set([
  'content-generation',  // "+ Request Post" flow
  'publisher',           // re-publish a stuck draft
  'speed-to-lead',       // re-fire on a specific lead
  'follow-up',           // re-fire on a specific lead
  'scoring',             // re-score on demand
  'enrichment',          // re-enrich on demand
  'review-request',      // re-send a review ask
  'digest',              // re-send the daily digest
  'meeting-prep',        // manually trigger a brief
  'reporting',           // re-generate a monthly report
]);

router.post('/trigger', async (req, res) => {
  try {
    const { agent_name, payload } = req.body || {};
    if (!agent_name || typeof agent_name !== 'string') {
      return res.status(400).json({ success: false, error: 'agent_name required' });
    }
    if (!TRIGGERABLE_AGENTS.has(agent_name)) {
      return res.status(403).json({
        success: false,
        error: `Agent "${agent_name}" cannot be triggered manually. Allowed: ${[...TRIGGERABLE_AGENTS].join(', ')}.`,
      });
    }
    // Whitelist the payload shape to a small, known set of keys — workers
    // ignore anything they don't recognize but we don't want callers passing
    // huge or sensitive blobs that get logged in agent_jobs.payload.
    const safePayload = {};
    const allowedKeys = ['lead_id', 'contact_id', 'format_id', 'platform', 'limit',
                         'custom_prompt', 'topic', 'draft_id', 'campaign_id'];
    for (const key of allowedKeys) {
      if (payload && payload[key] !== undefined) safePayload[key] = payload[key];
    }

    const job = await enqueueJob(req.tenantId, agent_name, safePayload, {
      priority: 5 // Manual triggers get medium priority
    });

    res.json({ success: true, job_id: job.id, status: 'queued' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Activity log
router.get('/activity/log', async (req, res) => {
  try {
    let query = db
      .from('agent_activity_log')
      .select('*')
      .eq('tenant_id', req.tenantId)
      .order('created_at', { ascending: false });

    if (req.query.agent) query = query.eq('agent_name', req.query.agent);
    if (req.query.status) query = query.eq('status', req.query.status);
    query = query.limit(parseInt(req.query.limit) || 100);

    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, activity: data, count: data.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
