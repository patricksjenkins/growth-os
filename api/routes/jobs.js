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

// Manually trigger an agent run
router.post('/trigger', async (req, res) => {
  try {
    const { agent_name, payload } = req.body;
    if (!agent_name) return res.status(400).json({ success: false, error: 'agent_name required' });

    const job = await enqueueJob(req.tenantId, agent_name, payload || {}, {
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
