/**
 * Admin — AI Safety Dashboard API (Phase 13 + Phase 14 + Release 2 controls)
 *
 * Read-only overview plus manual kill-switch / circuit-breaker / batch
 * controls. Mounted behind the same authMiddleware + adminMiddleware as the
 * other /api/admin routes (platform-owner only).
 *
 * IMPORTANT: setting a switch here only AFFECTS live traffic when the matching
 * enforcement flag is enabled (all default OFF). With enforcement off these
 * are manual records the system observes but does not act on — exactly the
 * Release 2 "manual controls, no automatic blocking" stage.
 */

'use strict';

const express = require('express');
const router = express.Router();

const { buildOverview } = require('../../core/ai-safety/overview');
const switchesLib = require('../../core/ai-safety/switches');
const { getServiceClient } = require('../../db/client');
const { createLogger } = require('../../core/logger');

const log = createLogger('admin-ai-safety');

// GET /api/admin/ai-safety/overview — full dashboard payload.
router.get('/overview', async (req, res) => {
  try {
    const data = await buildOverview();
    res.json({ success: true, ...data });
  } catch (err) {
    log.error('overview failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/admin/ai-safety/switch — manually open/close a kill switch or breaker.
// Body: { kind, scope, scopeValue, state, reason, autoReactivate }
router.post('/switch', async (req, res) => {
  try {
    const { kind, scope, scopeValue = '*', state, reason, autoReactivate = false } = req.body || {};
    const actor = req.user?.email || 'admin';
    const result = await switchesLib.setSwitch({ kind, scope, scopeValue, state, reason, actor, autoReactivate });
    if (!result.ok) return res.status(400).json({ success: false, error: result.error });
    res.json({ success: true, switch: result.switch });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/admin/ai-safety/batch/:id/:action — pause | cancel | approve a batch.
// Only meaningful when AI_MANUAL_BATCH_APPROVAL_ENABLED is on; otherwise it
// just updates the tracking record.
router.post('/batch/:id/:action', async (req, res) => {
  const { id, action } = req.params;
  const map = { pause: 'paused', cancel: 'cancelled', approve: 'approved' };
  const status = map[action];
  if (!status) return res.status(400).json({ success: false, error: 'invalid_action' });
  try {
    const db = getServiceClient();
    const { data, error } = await db.from('ai_job_batches')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', id).select().single();
    if (error) return res.status(400).json({ success: false, error: error.message });
    log.info(`batch ${id} -> ${status} by ${req.user?.email || 'admin'}`);
    res.json({ success: true, batch: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
