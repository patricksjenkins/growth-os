/**
 * First Gen Automate — Growth Engine (admin-only routes)
 *
 * Mounted at /api/admin/growth behind authMiddleware + adminMiddleware. Surfaces
 * the prospecting engine as one connected machine:
 *   GET  /                 latest funnel snapshot + Next Best Actions + alerts
 *   GET  /flow             per-agent ownership cards merged with live run status
 *   POST /focus            owner sets/approves this week's campaign focus
 *   POST /refresh          enqueue the orchestrator to rebuild the snapshot now
 *   GET  /suppressions     list central do-not-contact / competitor / bad-fit rows
 *   POST /suppressions     add a suppression
 *   DELETE /suppressions/:id  remove one
 *
 * Read-mostly. The only writes are owner-driven (focus, suppressions). The
 * snapshot itself is produced by the rules-based orchestrator (no paid API).
 */

const express = require('express');
const router = express.Router();

const { getServiceClient } = require('../../db/client');
const { createLogger } = require('../../core/logger');
const { FGA_TENANT_ID } = require('../../core/config');
const { resolveTenant } = require('../../core/tenant');
const { buildSnapshot, currentWeekStart, PROSPECTING_AGENTS } = require('../../core/growth/orchestrator');
const { OWNERSHIP, OVERLAP_RULES, CATEGORIES, categoryLabel } = require('../../core/growth/ownership');
const { normalizeEmail, normalizePhone, normalizeDomain } = require('../../core/growth/suppression');

const log = createLogger('admin-growth');

const SUPPRESSION_REASONS = new Set([
  'do_not_email', 'do_not_text', 'do_not_contact', 'unsubscribed', 'bounced',
  'bad_contact', 'competitor', 'bad_fit', 'not_interested', 'owner_blocked',
]);

// GET / — latest persisted snapshot; build one live if none exists yet.
router.get('/', async (req, res) => {
  try {
    const db = getServiceClient();
    const { data: rows } = await db.from('growth_engine_snapshots')
      .select('*').eq('tenant_id', FGA_TENANT_ID)
      .order('snapshot_at', { ascending: false }).limit(1);
    let snap = rows && rows[0];

    if (!snap) {
      const tenant = await resolveTenant(db, FGA_TENANT_ID);
      const built = await buildSnapshot(db, tenant);
      snap = { ...built, snapshot_at: null, live: true };
    }

    // Attach the owner-approved weekly focus (overrides the recommended one).
    const weekStart = currentWeekStart();
    const { data: focusRow } = await db.from('growth_campaign_focus')
      .select('*').eq('tenant_id', FGA_TENANT_ID).eq('week_start', weekStart).limit(1).maybeSingle();

    res.json({ success: true, data: { ...snap, focus_row: focusRow || null } });
  } catch (err) {
    log.error(`Growth snapshot failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /flow — ownership cards (static map) merged with live run status from
// agent_jobs over the trailing 7d, in the prospecting-engine flow order.
router.get('/flow', async (req, res) => {
  try {
    const db = getServiceClient();
    const since7d = new Date(Date.now() - 7 * 86400_000).toISOString();
    const since24h = new Date(Date.now() - 86400_000).toISOString();
    const { data: jobs } = await db.from('agent_jobs')
      .select('agent_name,status,error,created_at,completed_at')
      .gte('created_at', since7d).order('created_at', { ascending: false }).limit(8000);

    const live = new Map();
    for (const j of jobs || []) {
      let a = live.get(j.agent_name);
      if (!a) { a = { runs_7d: 0, failed_7d: 0, runs_24h: 0, last_run_at: null, last_status: null, last_error: null }; live.set(j.agent_name, a); }
      a.runs_7d += 1;
      if (j.created_at >= since24h) a.runs_24h += 1;
      if (j.status === 'failed') a.failed_7d += 1;
      if (a.last_run_at === null) { a.last_run_at = j.completed_at || j.created_at; a.last_status = j.status; a.last_error = j.error || null; }
    }

    // The flow order the owner reads top-to-bottom.
    const FLOW = [
      'prospecting-orchestrator', 'prospecting', 'enrichment', 'scoring',
      'outreach', 'reply-classification', 'drip-campaign', 'sales-nurture',
      'targeted-campaign', 'facebook-prospecting',
    ];
    const steps = FLOW.map((agent) => {
      const own = OWNERSHIP[agent] || {};
      const l = live.get(agent) || {};
      let status = 'idle';
      if (l.runs_24h > 0) status = l.last_status === 'failed' ? 'down' : (l.failed_7d > 0 ? 'degraded' : 'healthy');
      else if (l.runs_7d > 0) status = 'idle';
      else status = 'dormant';
      return {
        agent, status,
        category: own.category || null,
        category_label: own.category ? categoryLabel(own.category) : null,
        owns: own.owns || null, triggers: own.triggers || null,
        reads: own.reads || null, writes: own.writes || null,
        handoff_to: own.handoffTo || null, channel: own.channel || null,
        runs_7d: l.runs_7d || 0, failed_7d: l.failed_7d || 0,
        last_run_at: l.last_run_at || null, last_status: l.last_status || null,
        last_error: l.last_error || null,
      };
    });

    res.json({ success: true, data: { steps, overlaps: OVERLAP_RULES } });
  } catch (err) {
    log.error(`Growth flow failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /focus — owner sets/approves the weekly campaign focus.
router.post('/focus', async (req, res) => {
  try {
    const db = getServiceClient();
    const { vertical, geography, angle, status } = req.body || {};
    const weekStart = currentWeekStart();
    const newStatus = status === 'approved' || status === 'active' ? status : 'approved';
    const { data, error } = await db.from('growth_campaign_focus')
      .upsert({
        tenant_id: FGA_TENANT_ID, week_start: weekStart,
        vertical: vertical ?? null, geography: geography ?? null, angle: angle ?? null,
        status: newStatus, created_by: req.user?.email || 'owner', updated_at: new Date().toISOString(),
      }, { onConflict: 'tenant_id,week_start' })
      .select().maybeSingle();
    if (error) throw new Error(error.message);
    res.json({ success: true, data });
  } catch (err) {
    log.error(`Growth focus update failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /refresh — enqueue the orchestrator to rebuild the snapshot now.
router.post('/refresh', async (req, res) => {
  try {
    const { guardedEnqueue } = require('../../core/ai-safety/guarded-enqueue');
    const r = await guardedEnqueue({
      tenantId: FGA_TENANT_ID, agentName: 'prospecting-orchestrator', items: [{}],
      source: 'admin_route', reason: 'manual Growth Engine refresh', createdBy: req.user?.email || 'owner',
    });
    res.json({ success: true, enqueued: r.enqueued, batchId: r.batchId || null });
  } catch (err) {
    log.error(`Growth refresh failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /suppressions — central do-not-contact list.
router.get('/suppressions', async (req, res) => {
  try {
    const db = getServiceClient();
    const { data } = await db.from('lead_suppressions')
      .select('*').eq('tenant_id', FGA_TENANT_ID)
      .order('created_at', { ascending: false }).limit(500);
    res.json({ success: true, data: data || [] });
  } catch (err) {
    log.error(`Suppressions list failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /suppressions — add one (owner marks do-not-contact / competitor / bad-fit).
router.post('/suppressions', async (req, res) => {
  try {
    const { email, phone, domain, company_name, reason, channel, note, lead_id } = req.body || {};
    if (!SUPPRESSION_REASONS.has(reason)) {
      return res.status(400).json({ success: false, error: `reason must be one of: ${[...SUPPRESSION_REASONS].join(', ')}` });
    }
    const normEmail = normalizeEmail(email);
    const normPhone = normalizePhone(phone);
    if (!normEmail && !normPhone && !domain && !company_name && !lead_id) {
      return res.status(400).json({ success: false, error: 'at least one of email, phone, domain, company_name, lead_id is required' });
    }
    const db = getServiceClient();
    const row = {
      tenant_id: FGA_TENANT_ID, lead_id: lead_id || null,
      email: normEmail, phone: normPhone, domain: normalizeDomain(domain) || null,
      company_name: company_name || null, reason,
      channel: ['email', 'sms', 'all'].includes(channel) ? channel : 'all',
      source: 'owner_ui', note: note || null, created_by: req.user?.email || 'owner',
    };
    // Upsert on whichever unique key is present so re-adding updates, not errors.
    const onConflict = normEmail ? 'tenant_id,email' : normPhone ? 'tenant_id,phone' : undefined;
    const q = onConflict
      ? db.from('lead_suppressions').upsert(row, { onConflict })
      : db.from('lead_suppressions').insert(row);
    const { data, error } = await q.select().maybeSingle();
    if (error) throw new Error(error.message);
    res.json({ success: true, data });
  } catch (err) {
    log.error(`Suppression add failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /suppressions/:id
router.delete('/suppressions/:id', async (req, res) => {
  try {
    const db = getServiceClient();
    const { error } = await db.from('lead_suppressions')
      .delete().eq('tenant_id', FGA_TENANT_ID).eq('id', req.params.id);
    if (error) throw new Error(error.message);
    res.json({ success: true });
  } catch (err) {
    log.error(`Suppression delete failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
