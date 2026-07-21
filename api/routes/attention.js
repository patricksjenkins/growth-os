/**
 * Growth OS — Attention Queue Routes
 *
 * Phase 1 Step 7 of the BI & Financial Sync plan
 * (~/Desktop/FGA/dashboards/bi-sync-strategy.html §9.1-9.7).
 *
 * Read endpoints powering FIVE Command Center UI surfaces:
 *   - Action Ribbon (counters by severity)
 *   - Reconciliation Queue (filtered by type LIKE 'reconciliation_%')
 *   - Mobile Inbox (filtered by type IN categorization_needed, ...)
 *   - Drill-down detail (single item)
 *   - Resolve / dismiss actions
 *
 * Tenant-scoped via req.tenantId. Same auth gating as the rest of
 * /api/* — the route is mounted in server.js under the existing
 * authMiddleware + tenantMiddleware chain.
 */

const express = require('express');
const router = express.Router();
const { getUserClient } = require('../../db/userClient');
const { createLogger } = require('../../core/logger');
const log = createLogger('attention-routes');

// ============================================================================
// GET /api/attention/counters
//
// Returns counts by severity for the Action Ribbon. One row per severity
// (red / amber / blue) — frontend renders the badge color + count.
// Cheap query backed by the partial index `idx_attention_queue_ribbon`.
// ============================================================================
router.get('/counters', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { data, error } = await db.rpc('attention_queue_counters', {
      p_tenant_id: req.tenantId,
    });
    if (error) throw error;

    // Normalize into a flat object the UI can index by severity.
    const counters = { red: 0, amber: 0, blue: 0 };
    for (const row of data || []) counters[row.severity] = Number(row.count);
    const total = counters.red + counters.amber + counters.blue;

    res.json({ success: true, counters, total });
  } catch (err) {
    log.error(`/counters failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// GET /api/attention/items?type=&severity=&limit=
//
// Returns the open queue items. Supports filters:
//   type        — exact match OR prefix (passed as 'reconciliation_*' for
//                 the Reconciliation Queue view)
//   severity    — 'red' | 'amber' | 'blue'
//   include_resolved — 'true' to include already-resolved items (for audit)
//   limit       — default 50, max 200
// Sort order: severity (red → amber → blue), then most recent first.
// ============================================================================
router.get('/items', async (req, res) => {
  try {
    const db = getUserClient(req);
    // V1 hardening (2026-05-24): clamp lower bound too. Negative values
    // used to pass through and Supabase would error.
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 50, 200));
    const includeResolved = req.query.include_resolved === 'true';

    let q = db.from('attention_queue').select('*').eq('tenant_id', req.tenantId);
    if (!includeResolved) q = q.is('resolved_at', null);

    // Type filter — supports either exact match or a 'prefix*' pattern
    if (req.query.type) {
      const t = String(req.query.type);
      if (t.endsWith('*')) {
        q = q.like('type', t.replace('*', '%'));
      } else {
        q = q.eq('type', t);
      }
    }
    if (req.query.severity) q = q.eq('severity', String(req.query.severity));

    q = q.order('produced_at', { ascending: false }).limit(limit);
    const { data, error } = await q;
    if (error) throw error;

    // Severity-priority sort in JS (red > amber > blue), then by produced_at desc.
    // Supabase doesn't expose a CASE expression in order(), so we sort here.
    const sevRank = { red: 0, amber: 1, blue: 2 };
    const sorted = (data || []).sort((a, b) => {
      const sa = sevRank[a.severity] ?? 3;
      const sb = sevRank[b.severity] ?? 3;
      if (sa !== sb) return sa - sb;
      return new Date(b.produced_at).getTime() - new Date(a.produced_at).getTime();
    });

    res.json({ success: true, items: sorted });
  } catch (err) {
    log.error(`/items failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// GET /api/attention/:id
// Single item drill-down. Used by the detail modal when a user taps an
// item from the inbox / queue.
// ============================================================================
router.get('/:id', async (req, res) => {
  try {
    const db = getUserClient(req);
    const { data, error } = await db
      .from('attention_queue')
      .select('*')
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, item: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// POST /api/attention/:id/resolve
// Body: { resolution: 'accepted' | 'dismissed' | 'manual', payload?: {} }
//
// Marks an item as resolved. The item stays in the table for audit
// (resolved_at gets set; nothing is deleted). Common resolution paths:
//   - 'accepted'  — user took the queue item's quick action (e.g. categorized)
//   - 'dismissed' — user decided this isn't worth acting on
//   - 'manual'    — system flagged it but Patrick handled outside the UI
// ============================================================================

// V1 hardening (2026-05-24): factored out so /dismiss can call it directly
// instead of trying to re-route through router.handle() with a spread
// Express Request — that pattern strips the prototype chain and the
// router re-match was silently broken.
async function resolveAttentionItem(req, res, resolution, payload) {
  if (!['accepted', 'dismissed', 'manual', 'auto_resolved'].includes(resolution)) {
    return res.status(400).json({
      success: false,
      error: `Invalid resolution "${resolution}". Use: accepted | dismissed | manual | auto_resolved`,
    });
  }
  try {
    // Bug fix (2026-07-21): `db` was referenced without ever being bound in
    // this scope — every resolve/dismiss call threw ReferenceError (500),
    // which silently broke the mobile "Needs you" resolve buttons.
    const db = getUserClient(req);
    const { data, error } = await db
      .from('attention_queue')
      .update({
        resolved_at: new Date().toISOString(),
        resolved_by: req.user?.id || null,
        resolved_by_label: req.user?.email || 'unknown',
        resolution,
        resolution_payload: payload || null,
      })
      .eq('tenant_id', req.tenantId)
      .eq('id', req.params.id)
      .is('resolved_at', null)  // refuse double-resolve
      .select()
      .single();
    if (error) throw error;
    if (!data) {
      return res.status(409).json({
        success: false,
        error: 'Item already resolved or not found.',
      });
    }
    log.info(`Resolved attention_queue ${req.params.id} as "${resolution}" by ${data.resolved_by_label}`);
    return res.json({ success: true, item: data });
  } catch (err) {
    log.error(`/${req.params.id}/resolve failed: ${err.message}`);
    return res.status(500).json({ success: false, error: err.message });
  }
}

router.post('/:id/resolve', async (req, res) => {
  const resolution = req.body?.resolution || 'manual';
  return resolveAttentionItem(req, res, resolution, req.body?.payload);
});

// ============================================================================
// POST /api/attention/:id/dismiss — convenience alias for resolve with
// resolution='dismissed'. Used by mobile swipe-left gesture.
// ============================================================================
router.post('/:id/dismiss', async (req, res) => {
  return resolveAttentionItem(req, res, 'dismissed', req.body?.payload);
});

module.exports = router;
