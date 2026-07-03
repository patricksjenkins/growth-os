/**
 * Admin — Autonomous Outreach status + controls (2026-07-03)
 *
 * GET  /status   one consolidated payload for the Growth page panel:
 *                config, caps/ramp state, weekly target progress, queue
 *                counts, deliverability, decision log tail, go-live checklist
 * POST /pause    flip the emergency kill switch (autosend_paused)
 * POST /resume   clear it
 * POST /enable   arm autonomous mode (autonomous_outreach_enabled=true)
 * POST /disable  disarm it
 *
 * Mounted at /api/admin/autosend behind auth+admin middleware.
 */

const express = require('express');
const { createLogger } = require('../../core/logger');
const { getServiceClient } = require('../../db/client');
const { FGA_TENANT_ID } = require('../../core/config');
const { resolveTenant, clearTenantCache } = require('../../core/tenant');
const { autosendConfig, computeCapState, isoWeekStartIso } = require('../../core/auto-outreach');

const router = express.Router();
const log = createLogger('admin-autosend');

async function setFlag(key, value) {
  const db = getServiceClient();
  await db.from('tenant_config').upsert(
    { tenant_id: FGA_TENANT_ID, key, value: String(value) },
    { onConflict: 'tenant_id,key' },
  );
  try { clearTenantCache(FGA_TENANT_ID); } catch (_) { /* cache helper optional */ }
}

router.get('/status', async (req, res) => {
  try {
    const db = getServiceClient();
    const tenant = await resolveTenant(db, FGA_TENANT_ID);
    const cfgv = autosendConfig(tenant);
    const capState = await computeCapState(db, tenant);
    const weekStart = isoWeekStartIso();

    const [draftsRes, reviewRes, blockedRes, autoSentWeekRes, enrolledWeekRes, repliesWeekRes, decisionsRes] = await Promise.all([
      db.from('outreach_sequences').select('id', { count: 'exact', head: true })
        .eq('tenant_id', FGA_TENANT_ID).eq('sequence_type', 'email').eq('sequence_status', 'draft'),
      db.from('leads').select('id', { count: 'exact', head: true })
        .eq('tenant_id', FGA_TENANT_ID).eq('automation_status', 'needs_review'),
      db.from('leads').select('id', { count: 'exact', head: true })
        .eq('tenant_id', FGA_TENANT_ID).in('automation_status', ['blocked_suppressed', 'blocked_duplicate', 'blocked_no_email']),
      db.from('autosend_decisions').select('id', { count: 'exact', head: true })
        .eq('tenant_id', FGA_TENANT_ID).eq('decision', 'sent').gte('created_at', weekStart),
      db.from('drip_enrollments').select('id', { count: 'exact', head: true })
        .eq('tenant_id', FGA_TENANT_ID).gte('created_at', weekStart),
      db.from('leads').select('id', { count: 'exact', head: true })
        .eq('tenant_id', FGA_TENANT_ID).eq('status', 'replied').gte('updated_at', weekStart),
      db.from('autosend_decisions').select('id, lead_id, decision, reason, created_at, quality')
        .eq('tenant_id', FGA_TENANT_ID).order('created_at', { ascending: false }).limit(25),
    ]);

    // Go-live checklist — every row must be green before flipping enable.
    const { data: gmailConn } = await db.from('email_connections')
      .select('email_address, updated_at').eq('tenant_id', FGA_TENANT_ID).eq('provider', 'gmail').maybeSingle();
    const dnsRecords = (() => {
      try { const raw = tenant.config?.outreach_domain_dns; return raw ? JSON.parse(raw) : []; } catch { return []; }
    })();
    const checklist = {
      postal_address: Boolean(cfgv.postalAddress),
      reply_sync_connected: Boolean(gmailConn),
      drip_enabled: String(tenant.config?.drip_campaign_enabled) === 'true',
      bounce_webhook_secret: Boolean(process.env.RESEND_WEBHOOK_SECRET),
      sending_domain: {
        name: tenant.config?.outreach_domain_name || null,
        from_email: tenant.config?.autosend_from_email || null,
        dns_records: dnsRecords,
        note: 'Optional but recommended: verify the outreach subdomain in DNS, then set autosend_from_email. Until then sends stay on the main domain under the ramp cap.',
      },
    };

    res.json({
      success: true,
      data: {
      config: {
        enabled: cfgv.enabled,
        paused: cfgv.paused,
        daily_cap: cfgv.dailyCap,
        daily_max: cfgv.dailyMax,
        weekly_target: cfgv.weeklyTarget,
        score_threshold: cfgv.scoreThreshold,
        quality_threshold: cfgv.qualityThreshold,
      },
      week: {
        auto_sent: autoSentWeekRes.count || 0,
        target: cfgv.weeklyTarget,
        enrolled_in_drip: enrolledWeekRes.count || 0,
        replies: repliesWeekRes.count || 0,
      },
      today: {
        sent: capState.sentToday,
        cap: capState.dailyCap,
        remaining: capState.dailyRemaining,
      },
      queue: {
        drafts_ready: draftsRes.count || 0,
        needs_review: reviewRes.count || 0,
        blocked: blockedRes.count || 0,
      },
      deliverability: {
        paused: capState.deliverabilityPaused,
        bounce_rate_7d: capState.bounceRate7d,
        complaints_7d: capState.complaints7d,
        sent_7d: capState.sent7d,
      },
      checklist,
      recent_decisions: decisionsRes.data || [],
      },
    });
  } catch (err) {
    log.error(`/status failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/pause', async (_req, res) => {
  await setFlag('autosend_paused', 'true');
  res.json({ success: true, paused: true });
});
router.post('/resume', async (_req, res) => {
  await setFlag('autosend_paused', 'false');
  res.json({ success: true, paused: false });
});
router.post('/enable', async (_req, res) => {
  await setFlag('autonomous_outreach_enabled', 'true');
  res.json({ success: true, enabled: true });
});
router.post('/disable', async (_req, res) => {
  await setFlag('autonomous_outreach_enabled', 'false');
  res.json({ success: true, enabled: false });
});

module.exports = router;
