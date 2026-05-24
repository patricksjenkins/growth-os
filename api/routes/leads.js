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

    // V1 hardening (2026-05-24): each downstream enqueue is wrapped in its
    // own try/catch so a single agent_jobs failure doesn't 500 the whole
    // request — the lead row is already saved and the caller needs a
    // success response or they'll retry and create duplicates.
    // Failures are logged and surfaced via a partial-success indicator
    // in the response body; the sweeper crons will pick the lead up
    // within their windows anyway.
    const enqueueWarnings = [];
    async function tryEnqueue(name, jobPayload, priority) {
      try {
        await db.from('agent_jobs').insert({
          tenant_id: req.tenantId,
          agent_name: name,
          payload: jobPayload,
          status: 'pending',
          priority,
        });
      } catch (e) {
        enqueueWarnings.push(`${name}: ${e.message}`);
      }
    }

    // Speed-to-lead (inbound / customer-facing).
    // Only enqueue if: module is enabled AND lead has a phone AND tenant
    // actually has Twilio wired up. Otherwise the job is guaranteed to
    // fail with "Twilio integration not configured" — which just pollutes
    // the daily digest's failure count (see digest 2026-04-22).
    const tw = req.tenant?.integrations?.twilio;
    const twilioReady = !!(tw && tw.credentials?.account_sid && tw.config?.phone_number);
    if (isModuleEnabled(req.tenant, 'speed_to_lead') && lead.phone && twilioReady) {
      await tryEnqueue('speed-to-lead', { lead_id: lead.id }, 10);
    }

    // Auto-enrich any manually-created prospect so it enters the outreach
    // funnel without Patrick having to do anything else. Skip if the lead
    // was created with an already-set lifecycle_stage (e.g. bulk import
    // with pre-enriched data).
    const enqueueEnrichment =
      lead.lead_source !== 'prospecting_agent' &&   // prospecting enriches inline
      (lead.lifecycle_stage === 'prospect' || lead.lifecycle_stage === null || lead.lifecycle_stage === undefined);
    if (enqueueEnrichment) {
      await tryEnqueue('enrichment', { lead_id: lead.id }, 7);
    }

    // Auto-enqueue Lead Scoring + Follow-Up so the platform meets the
    // Module 1 promise: "hands every new lead off to Speed-to-Lead,
    // Follow-Up, and Lead Scoring automatically." Both run at a lower
    // priority than speed-to-lead (which is immediate) and enrichment
    // (which feeds the others); scoring re-runs anyway after enrichment
    // completes so the first-pass score uses whatever signals exist now.
    if (isModuleEnabled(req.tenant, 'lead_scoring')) {
      await tryEnqueue('scoring', { lead_id: lead.id }, 5);
    }
    if (isModuleEnabled(req.tenant, 'follow_up')) {
      await tryEnqueue('follow-up', { lead_id: lead.id }, 5);
    }

    const body = { success: true, lead };
    if (enqueueWarnings.length) body.enqueue_warnings = enqueueWarnings;
    res.status(201).json(body);
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
