/**
 * Growth OS — Content Routes
 * CRUD + approval for content drafts
 */

const express = require('express');
const router = express.Router();
const { requireModule } = require('../../core/modules');
const contentDb = require('../../db/queries/content');
const { db } = require('../../db/client');

// All content routes require content_engine module
router.use(requireModule('content_engine'));

// List drafts
router.get('/', async (req, res) => {
  try {
    const drafts = await contentDb.getDrafts(req.tenantId, {
      status: req.query.status,
      platform: req.query.platform,
      limit: parseInt(req.query.limit) || 50
    });
    res.json({ success: true, drafts, count: drafts.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get single draft
router.get('/:id', async (req, res) => {
  try {
    const draft = await contentDb.getDraft(req.tenantId, req.params.id);
    if (!draft) return res.status(404).json({ success: false, error: 'Draft not found' });
    res.json({ success: true, draft });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Generate content (enqueues a job for the worker)
router.post('/generate', async (req, res) => {
  try {
    const { data: job, error } = await db
      .from('agent_jobs')
      .insert({
        tenant_id: req.tenantId,
        agent_name: 'content-generation',
        payload: {
          topic: req.body.topic,
          format_id: req.body.format_id,
          platform: req.body.platform || 'linkedin'
        },
        status: 'pending'
      })
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, job_id: job.id, status: 'queued' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Approve draft
router.put('/:id/approve', async (req, res) => {
  try {
    const draft = await contentDb.approveDraft(req.tenantId, req.params.id, req.userId);
    if (!draft) return res.status(400).json({ success: false, error: 'Draft not found or not in draft status' });
    res.json({ success: true, draft });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Reject draft
router.put('/:id/reject', async (req, res) => {
  try {
    const draft = await contentDb.rejectDraft(req.tenantId, req.params.id, req.userId, req.body.reason);
    if (!draft) return res.status(400).json({ success: false, error: 'Draft not found or not in draft status' });
    res.json({ success: true, draft });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
