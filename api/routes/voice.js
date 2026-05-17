/**
 * Growth OS — Voice Receptionist Routes (Module 9)
 *
 * GET  /api/voice/calls           — list AI-handled calls for the calling tenant
 * GET  /api/voice/calls/:id       — single call detail (full transcript)
 * GET  /api/voice/usage           — current month voice-minutes-used vs cap
 *
 * Privacy: voice_calls intentionally has NO audio fields. These routes
 * only surface text transcripts and metadata.
 */

const express = require('express');
const router = express.Router();
const { requireModule } = require('../../core/modules');
const { getConfig } = require('../../core/config');
const { db } = require('../../db/client');
const { createLogger } = require('../../core/logger');

const log = createLogger('voice-routes');

router.use(requireModule('voice_receptionist'));

// ----- GET /api/voice/calls — recent AI-handled calls -----
router.get('/calls', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const { data, error } = await db
      .from('voice_calls')
      .select('id, twilio_call_sid, caller_phone, duration_seconds, transcript, classification, captured_lead_id, emergency_flagged, owner_notified, created_at')
      .eq('tenant_id', req.tenantId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    res.json({ success: true, calls: data || [] });
  } catch (err) {
    log.error(`/voice/calls failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ----- GET /api/voice/calls/:id — single call detail -----
router.get('/calls/:id', async (req, res) => {
  try {
    const { data, error } = await db
      .from('voice_calls')
      .select('*')
      .eq('id', req.params.id)
      .eq('tenant_id', req.tenantId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ success: false, error: 'Call not found' });
    res.json({ success: true, call: data });
  } catch (err) {
    log.error(`/voice/calls/:id failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ----- GET /api/voice/usage — current cap + used minutes -----
router.get('/usage', async (req, res) => {
  try {
    const cap = Number(getConfig(req.tenant, 'voice_receptionist_minutes_cap', 200));
    const { data: usage } = await db
      .from('tenant_usage')
      .select('voice_minutes_used')
      .eq('tenant_id', req.tenantId)
      .maybeSingle();
    const used = Number(usage?.voice_minutes_used || 0);
    res.json({
      success: true,
      used_minutes: used,
      cap_minutes: cap,
      remaining_minutes: Math.max(0, cap - used),
      over_cap: used >= cap,
    });
  } catch (err) {
    log.error(`/voice/usage failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
