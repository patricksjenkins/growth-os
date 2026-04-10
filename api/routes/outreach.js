/**
 * Growth OS — Outreach Routes
 */

const express = require('express');
const router = express.Router();
const { requireModule } = require('../../core/modules');
const outreachDb = require('../../db/queries/outreach');
const { validateBody, validateId } = require('../middleware/validate');

router.use(requireModule('outreach_drip'));

// List campaigns
router.get('/', async (req, res) => {
  try {
    const campaigns = await outreachDb.getCampaigns(req.tenantId, {
      status: req.query.status,
      campaign_type: req.query.type,
      limit: parseInt(req.query.limit) || 100
    });
    res.json({ success: true, campaigns, count: campaigns.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Campaign stats
router.get('/stats', async (req, res) => {
  try {
    const stats = await outreachDb.getCampaignStats(req.tenantId);
    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get single campaign
router.get('/:id', validateId(), async (req, res) => {
  try {
    const campaign = await outreachDb.getCampaign(req.tenantId, req.params.id);
    if (!campaign) return res.status(404).json({ success: false, error: 'Campaign not found' });
    res.json({ success: true, campaign });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Create campaign
router.post('/', validateBody({ contact_id: 'uuid' }), async (req, res) => {
  try {
    const campaign = await outreachDb.createCampaign(req.tenantId, req.body);
    res.status(201).json({ success: true, campaign });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Pause campaign
router.put('/:id/pause', validateId(), async (req, res) => {
  try {
    const campaign = await outreachDb.pauseCampaign(req.tenantId, req.params.id);
    if (!campaign) return res.status(404).json({ success: false, error: 'Campaign not found' });
    res.json({ success: true, campaign });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Complete campaign
router.put('/:id/complete', validateId(), async (req, res) => {
  try {
    const campaign = await outreachDb.completeCampaign(req.tenantId, req.params.id);
    if (!campaign) return res.status(404).json({ success: false, error: 'Campaign not found' });
    res.json({ success: true, campaign });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
