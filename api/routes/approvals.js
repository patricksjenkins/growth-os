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

// Delete — hard-delete a draft without regenerating. Owner uses this when
// the post topic is wrong-headed and they don't want a fresh attempt;
// they'd rather wait for the next scheduled generation. Distinct from
// the reject-with-feedback path, which always queues a regen.
//
// Only operates on rows still in draft/pending/rejected — once a post is
// approved or posted we refuse, since downstream Buffer scheduling makes
// the delete ambiguous.
router.delete('/:id', async (req, res) => {
  try {
    const { db } = require('../../db/client');
    const { data: existing, error: lookupErr } = await db
      .from('content_drafts')
      .select('id, status')
      .eq('id', req.params.id)
      .eq('tenant_id', req.tenantId)
      .maybeSingle();
    if (lookupErr) throw lookupErr;
    if (!existing) return res.status(404).json({ success: false, error: 'Draft not found' });
    if (!['draft', 'pending', 'rejected'].includes(existing.status)) {
      return res.status(400).json({
        success: false,
        error: `Cannot delete draft in status "${existing.status}". Only draft/pending/rejected can be deleted.`,
      });
    }
    const { error: delErr } = await db
      .from('content_drafts')
      .delete()
      .eq('id', req.params.id)
      .eq('tenant_id', req.tenantId);
    if (delErr) throw delErr;
    res.json({ success: true, deleted_id: req.params.id });
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
