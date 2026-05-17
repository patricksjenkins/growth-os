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

// List leads (supports search, status, source, tier filters)
router.get('/', async (req, res) => {
  try {
    const leads = await leadsDb.getLeads(req.tenantId, {
      status: req.query.status,
      lead_source: req.query.source,
      priority_tier: req.query.tier,
      search: req.query.search,
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
    // Default lead_source='manual' so we can distinguish human-added leads
    // from prospecting_agent-generated ones. Manual leads flow through the
    // same enrichment → outreach funnel.
    const payload = { lead_source: 'manual', ...req.body };
    const lead = await leadsDb.createLead(req.tenantId, payload);

    // Speed-to-lead (inbound / customer-facing).
    // Only enqueue if: module is enabled AND lead has a phone AND tenant
    // actually has Twilio wired up. Otherwise the job is guaranteed to
    // fail with "Twilio integration not configured" — which just pollutes
    // the daily digest's failure count (see digest 2026-04-22).
    const tw = req.tenant?.integrations?.twilio;
    const twilioReady = !!(tw && tw.credentials?.account_sid && tw.config?.phone_number);
    if (isModuleEnabled(req.tenant, 'speed_to_lead') && lead.phone && twilioReady) {
      await db.from('agent_jobs').insert({
        tenant_id: req.tenantId,
        agent_name: 'speed-to-lead',
        payload: { lead_id: lead.id },
        status: 'pending',
        priority: 10
      });
    }

    // Auto-enrich any manually-created prospect so it enters the outreach
    // funnel without Patrick having to do anything else. Skip if the lead
    // was created with an already-set lifecycle_stage (e.g. bulk import
    // with pre-enriched data).
    const enqueueEnrichment =
      lead.lead_source !== 'prospecting_agent' &&   // prospecting enriches inline
      (lead.lifecycle_stage === 'prospect' || lead.lifecycle_stage === null || lead.lifecycle_stage === undefined);
    if (enqueueEnrichment) {
      await db.from('agent_jobs').insert({
        tenant_id: req.tenantId,
        agent_name: 'enrichment',
        payload: { lead_id: lead.id },
        status: 'pending',
        priority: 7,
      });
    }

    // Auto-enqueue Lead Scoring + Follow-Up so the platform meets the
    // Module 1 promise: "hands every new lead off to Speed-to-Lead,
    // Follow-Up, and Lead Scoring automatically." Both run at a lower
    // priority than speed-to-lead (which is immediate) and enrichment
    // (which feeds the others); scoring re-runs anyway after enrichment
    // completes so the first-pass score uses whatever signals exist now.
    if (isModuleEnabled(req.tenant, 'lead_scoring')) {
      await db.from('agent_jobs').insert({
        tenant_id: req.tenantId,
        agent_name: 'scoring',
        payload: { lead_id: lead.id },
        status: 'pending',
        priority: 5,
      });
    }
    if (isModuleEnabled(req.tenant, 'follow_up')) {
      await db.from('agent_jobs').insert({
        tenant_id: req.tenantId,
        agent_name: 'follow-up',
        payload: { lead_id: lead.id },
        status: 'pending',
        priority: 5,
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
