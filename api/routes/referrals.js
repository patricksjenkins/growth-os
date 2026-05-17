/**
 * Growth OS — Tenant-Scoped Referrals
 *
 * GET  /api/referrals             — leaderboard for the calling tenant
 * GET  /api/referrals/credits     — raw credit ledger (latest first)
 * POST /api/referrals/:id/mark-paid — flip an owed credit to paid
 *
 * These endpoints back the customer-facing referral leaderboard in the
 * mobile app and web portal (Module 10.6). The admin-only equivalent at
 * /api/admin/referrals lets Patrick view any tenant; this version is
 * locked to req.tenantId via the global tenantMiddleware.
 */

const express = require('express');
const router = express.Router();
const { requireModule } = require('../../core/modules');
const { db } = require('../../db/client');
const { createLogger } = require('../../core/logger');

const log = createLogger('referrals');

router.use(requireModule('referral_engine'));

// ----- GET /api/referrals — leaderboard summary -----
router.get('/', async (req, res) => {
  try {
    const tenantId = req.tenantId;
    let q = db
      .from('referral_credits')
      .select(
        'id, amount, status, source, created_at, owed_at, paid_at, referrer_lead_id, referee_lead_id, ' +
        'referrer:leads!referral_credits_referrer_lead_id_fkey(id, name, company_name), ' +
        'referee:leads!referral_credits_referee_lead_id_fkey(id, name, company_name, status)',
      )
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false });
    if (req.query.status) q = q.eq('status', req.query.status);

    const { data: credits, error } = await q;
    if (error) throw error;

    const byReferrer = new Map();
    for (const c of credits || []) {
      const rid = c.referrer_lead_id;
      if (!byReferrer.has(rid)) {
        byReferrer.set(rid, {
          referrer_lead_id: rid,
          referrer_name: c.referrer?.name || c.referrer?.company_name || 'Unknown',
          total_referrals: 0,
          won_referrals: 0,
          lost_referrals: 0,
          pending_referrals: 0,
          total_amount_owed: 0,
          total_amount_paid: 0,
        });
      }
      const row = byReferrer.get(rid);
      row.total_referrals++;
      const refereeStatus = c.referee?.status;
      if (refereeStatus === 'won') row.won_referrals++;
      else if (refereeStatus === 'lost') row.lost_referrals++;
      else row.pending_referrals++;
      const amount = Number(c.amount || 0);
      if (c.status === 'owed') row.total_amount_owed += amount;
      else if (c.status === 'paid') row.total_amount_paid += amount;
    }

    const leaderboard = [...byReferrer.values()].sort((a, b) =>
      b.won_referrals - a.won_referrals || b.total_referrals - a.total_referrals,
    );

    const summary = {
      total_credits: (credits || []).length,
      total_owed: leaderboard.reduce((s, r) => s + r.total_amount_owed, 0),
      total_paid: leaderboard.reduce((s, r) => s + r.total_amount_paid, 0),
      active_referrers: leaderboard.filter((r) => r.total_referrals > 0).length,
    };

    res.json({ success: true, summary, leaderboard });
  } catch (err) {
    log.error(`Tenant referrals failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ----- GET /api/referrals/credits — raw ledger -----
router.get('/credits', async (req, res) => {
  try {
    const tenantId = req.tenantId;
    let q = db
      .from('referral_credits')
      .select(
        'id, amount, status, source, created_at, owed_at, paid_at, referrer_lead_id, referee_lead_id, ' +
        'referrer:leads!referral_credits_referrer_lead_id_fkey(id, name, company_name), ' +
        'referee:leads!referral_credits_referee_lead_id_fkey(id, name, company_name, status)',
      )
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(Number(req.query.limit) || 200);
    if (req.query.status) q = q.eq('status', req.query.status);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ success: true, credits: data || [] });
  } catch (err) {
    log.error(`Tenant referrals/credits failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ----- POST /api/referrals/:id/mark-paid — flip owed → paid -----
router.post('/:id/mark-paid', async (req, res) => {
  try {
    const tenantId = req.tenantId;
    // Scope to the calling tenant AND require status='owed' so we don't
    // accidentally double-pay or reopen a void credit.
    const { data, error } = await db
      .from('referral_credits')
      .update({ status: 'paid', paid_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('tenant_id', tenantId)
      .eq('status', 'owed')
      .select('id, status, paid_at')
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      return res.status(404).json({ success: false, error: 'Credit not found, not owed, or not in your tenant' });
    }
    res.json({ success: true, credit: data });
  } catch (err) {
    log.error(`Mark-paid failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
