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

// Reject
router.post('/:id/reject', async (req, res) => {
  try {
    const draft = await contentDb.rejectDraft(req.tenantId, req.params.id, req.userId, req.body.reason);
    if (!draft) return res.status(400).json({ success: false, error: 'Not found or not a draft' });
    res.json({ success: true, draft });
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
