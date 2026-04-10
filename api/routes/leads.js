/**
 * Growth OS — Lead Routes
 */

const express = require('express');
const router = express.Router();
const { requireModule } = require('../../core/modules');
const { isModuleEnabled } = require('../../core/modules');
const leadsDb = require('../../db/queries/leads');
const { db } = require('../../db/client');

router.use(requireModule('lead_capture'));

// List leads
router.get('/', async (req, res) => {
  try {
    const leads = await leadsDb.getLeads(req.tenantId, {
      status: req.query.status,
      lead_source: req.query.source,
      priority_tier: req.query.tier,
      limit: parseInt(req.query.limit) || 100
    });
    res.json({ success: true, leads, count: leads.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Pipeline stats
router.get('/stats', async (req, res) => {
  try {
    const stats = await leadsDb.getPipelineStats(req.tenantId);
    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get single lead
router.get('/:id', async (req, res) => {
  try {
    const lead = await leadsDb.getLead(req.tenantId, req.params.id);
    if (!lead) return res.status(404).json({ success: false, error: 'Lead not found' });
    res.json({ success: true, lead });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Create lead
router.post('/', async (req, res) => {
  try {
    const lead = await leadsDb.createLead(req.tenantId, req.body);

    // If speed-to-lead is enabled, enqueue the agent
    if (isModuleEnabled(req.tenant, 'speed_to_lead') && lead.phone) {
      await db.from('agent_jobs').insert({
        tenant_id: req.tenantId,
        agent_name: 'speed-to-lead',
        payload: { lead_id: lead.id },
        status: 'pending',
        priority: 10 // High priority — speed matters
      });
    }

    res.status(201).json({ success: true, lead });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Update lead
router.put('/:id', async (req, res) => {
  try {
    const lead = await leadsDb.updateLead(req.tenantId, req.params.id, req.body);
    if (!lead) return res.status(404).json({ success: false, error: 'Lead not found' });
    res.json({ success: true, lead });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
