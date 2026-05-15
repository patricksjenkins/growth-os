/**
 * Growth OS — Approvals Routes (mobile-optimized)
 */

const express = require('express');
const router = express.Router();
const contentDb = require('../../db/queries/content');

// Pending approvals
router.get('/pending', async (req, res) => {
  try {
    const drafts = await contentDb.getDrafts(req.tenantId, { status: 'draft' });
    res.json({ success: true, pending: drafts, count: drafts.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Approve
router.post('/:id/approve', async (req, res) => {
  try {
    const draft = await contentDb.approveDraft(req.tenantId, req.params.id, req.userId);
    if (!draft) return res.status(400).json({ success: false, error: 'Not found or not a draft' });
    res.json({ success: true, draft });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Reject — optionally regenerate with feedback.
// Body: { reason?: string, regenerate?: boolean }
// When regenerate=true (or feedback text is meaningful), we enqueue a
// content-generation job using the SAME format_id as the rejected draft,
// with `regenerate_feedback` in the payload so the agent can inject the
// owner's guidance into the system prompt for the new attempt.
router.post('/:id/reject', async (req, res) => {
  try {
    const { db } = require('../../db/client');
    const reason = (req.body?.reason || '').trim();
    const shouldRegenerate = !!req.body?.regenerate || !!reason;

    const draft = await contentDb.rejectDraft(req.tenantId, req.params.id, req.userId, reason || null);
    if (!draft) return res.status(400).json({ success: false, error: 'Not found or not a draft' });

    let regeneratedJobId = null;
    if (shouldRegenerate) {
      // Pull the rejected draft so we know which format to regenerate
      // (rejectDraft above returns the updated row; format_template is
      // 'format-<id>' so we strip the prefix).
      const formatId = parseInt(String(draft.format_template || '').replace(/^format-/, ''), 10);
      const payload = {
        platform: draft.platform || 'instagram',
        regenerate_feedback: reason || null,
        rejected_draft_id: draft.id,
      };
      if (Number.isFinite(formatId) && formatId > 0) payload.format_id = formatId;

      const { data: job, error: jobErr } = await db.from('agent_jobs').insert({
        tenant_id: req.tenantId,
        agent_name: 'content-generation',
        payload,
        status: 'pending',
      }).select('id').single();
      if (jobErr) {
        // Don't fail the reject if regen queue fails — the draft is still rejected.
        console.warn('Regenerate queue failed:', jobErr.message);
      } else {
        regeneratedJobId = job.id;
      }
    }

    res.json({ success: true, draft, regenerate_job_id: regeneratedJobId });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Posted history
router.get('/posted', async (req, res) => {
  try {
    const posted = await contentDb.getDrafts(req.tenantId, { status: 'posted', limit: 50 });
    res.json({ success: true, posted, count: posted.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
