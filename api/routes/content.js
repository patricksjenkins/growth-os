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
// Accepts: { topic, custom_prompt, format_id, platform, media_kind, media_urls }
// - custom_prompt: owner's specific question/idea to build the post around
// - topic:         force a specific content pillar (optional)
// - media_kind:    'single' | 'before_after' | 'video' (optional — present
//                   only when the user attached media via the new
//                   "+ Request Post" modal)
// - media_urls:    parallel array of public Supabase Storage URLs.
//                   For before_after: [BEFORE_URL, AFTER_URL] in order.
//                   For single + video: single-element array.
// - If neither prompt nor media is provided, picks a random pillar.
router.post('/generate', async (req, res) => {
  try {
    const mediaKind = req.body.media_kind || null;
    const mediaUrls = Array.isArray(req.body.media_urls) ? req.body.media_urls.filter(Boolean) : null;

    // Light validation — only enforce shape when the caller actually
    // sent media. Pre-existing callers (text-only) keep working.
    if (mediaKind && !['single', 'before_after', 'video'].includes(mediaKind)) {
      return res.status(400).json({ success: false, error: 'media_kind must be single, before_after, or video' });
    }
    if (mediaKind && (!mediaUrls || mediaUrls.length === 0)) {
      return res.status(400).json({ success: false, error: 'media_urls required when media_kind is set' });
    }
    if (mediaKind === 'before_after' && (!mediaUrls || mediaUrls.length !== 2)) {
      return res.status(400).json({ success: false, error: 'before_after requires exactly two media_urls in [before, after] order' });
    }

    const { data: job, error } = await db
      .from('agent_jobs')
      .insert({
        tenant_id: req.tenantId,
        agent_name: 'content-generation',
        payload: {
          custom_prompt: req.body.custom_prompt || null,
          topic: req.body.topic || null,
          format_id: req.body.format_id,
          platform: req.body.platform || 'instagram',
          // Media fields are optional — worker branches on their presence.
          media_kind: mediaKind,
          media_urls: mediaUrls,
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
